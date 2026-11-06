import type { CommandHandlers } from "./command-funnel";
import { handlersFor } from "./command-funnel";
import type { Store } from "./store";
import { activeReleaseRecord } from "../modules/configuration/index";
import { BrainDomainError } from "../domain/errors";
import { assertExpectedVersion } from "../domain/states";
import type { BrainAuth } from "../modules/identity/index";
import type { JobProtocol } from "../modules/jobs/index";

/**
 * Workspace administration commands: memberships and the workspace lifecycle.
 * All of them change control.db authority, so they commit with the receipt.
 */
export function workspaceAdminCommands(store: Store, auth: BrainAuth, jobs: Pick<JobProtocol, "workspaceJobLoad">): CommandHandlers {
  const s = store;
  return {
    ...handlersFor(["member.grant", "member.revoke"], {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const p = cmd.payload;
        const principalId = String(p["principalId"]); const role = String(p["role"]);
        const activePrincipal = s.control.prepare("SELECT 1 AS active FROM principals WHERE id=? AND organization_id=? AND kind='human' AND disabled_at_ms IS NULL").get(principalId, actor.organizationId);
        if (!activePrincipal) throw new BrainDomainError("NOT_FOUND", "active organization member not found");
        const authOrganization = s.control.prepare("SELECT auth_organization_id FROM organizations WHERE id=?").get(actor.organizationId) as { auth_organization_id: string };
        if (!auth.hasMembership(principalId, authOrganization.auth_organization_id)) throw new BrainDomainError("FORBIDDEN", "current Better Auth organization membership required");
        const wsRow = s.control.prepare("SELECT version FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, actor.organizationId) as { version: number } | undefined;
        if (!wsRow) throw new BrainDomainError("NOT_FOUND", "workspace not found");
        assertExpectedVersion(wsRow.version, cmd.expectedVersion);
        if (cmd.commandType === "member.grant") {
          s.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,?,1,?,?) ON CONFLICT(workspace_id,principal_id,role) DO UPDATE SET revoked_at_ms=NULL, version=workspace_memberships.version+1")
            .run(workspaceId, actor.organizationId, principalId, role, actor.actorId, s.now());
        } else {
          s.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=?, version=version+1 WHERE workspace_id=? AND principal_id=? AND role=?").run(s.now(), workspaceId, principalId, role);
        }
        s.control.prepare("UPDATE workspaces SET version=version+1 WHERE id=?").run(workspaceId);
        s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "membership", aggregateId: principalId, eventType: cmd.commandType === "member.grant" ? "membership.granted" : "membership.revoked", payload: { principalId, role } });
        return { resourceId: principalId };
      },
    }),
    "workspace.update": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        const p = cmd.payload;
        if (!workspaceId || String(p["workspaceId"]) !== workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspace scope mismatch");
        const workspace = s.control.prepare("SELECT version FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, actor.organizationId) as { version: number } | undefined;
        if (!workspace) throw new BrainDomainError("NOT_FOUND", "workspace not found");
        assertExpectedVersion(workspace.version, cmd.expectedVersion);
        const ownerId = String(p["ownerId"]);
        if (!s.control.prepare("SELECT 1 FROM principals WHERE id=? AND organization_id=? AND kind='human' AND disabled_at_ms IS NULL").get(ownerId, actor.organizationId)) throw new BrainDomainError("NOT_FOUND", "workspace owner must be an active organization member");
        const displayName = String(p["displayName"]).trim();
        if (!displayName) throw new BrainDomainError("INVALID_ARGUMENT", "display name is required");
        const changed = s.control.prepare("UPDATE workspaces SET slug=?,description=?,owner_id=?,tags_json=?,version=version+1 WHERE id=? AND organization_id=? AND version=?")
          .run(displayName, String(p["description"] ?? ""), ownerId, JSON.stringify(p["tags"] ?? []), workspaceId, actor.organizationId, workspace.version);
        if (changed.changes !== 1) throw new BrainDomainError("CONFLICT", "workspace changed during editing");
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: "workspace.updated", payload: { workspaceId, ownerId, displayName } });
        return { resourceId: workspaceId };
      },
    },
    "workspace.control": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        const p = cmd.payload;
        if (!workspaceId || String(p["workspaceId"]) !== workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspace scope mismatch");
        const action = String(p["action"]);
        const reason = String(p["reason"] ?? "").trim();
        if (!reason) throw new BrainDomainError("INVALID_ARGUMENT", "workspace lifecycle changes require a reason");
        const workspace = s.control.prepare("SELECT status,version FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, actor.organizationId) as { status: string; version: number } | undefined;
        if (!workspace) throw new BrainDomainError("NOT_FOUND", "workspace not found");
        assertExpectedVersion(workspace.version, cmd.expectedVersion);
        if (action === "resume") {
          if (workspace.status !== "suspended") throw new BrainDomainError("CONFLICT", "only a suspended workspace can resume");
          if (!activeReleaseRecord(s, actor.organizationId)) throw new BrainDomainError("CONFLICT", "an active configuration release is required before resume");
          if (jobs.workspaceJobLoad(workspaceId).unresolved > 0) throw new BrainDomainError("CONFLICT", "reconcile unknown outcomes before resuming the workspace");
        } else if (action === "suspend") {
          if (workspace.status !== "active") throw new BrainDomainError("CONFLICT", "only an active workspace can suspend");
        } else if (action === "archive") {
          if (workspace.status === "archived") return { resourceId: workspaceId };
          if (jobs.workspaceJobLoad(workspaceId).active > 0) throw new BrainDomainError("CONFLICT", "archive requires no active, blocked or unresolved work");
        } else {
          throw new BrainDomainError("INVALID_ARGUMENT", "workspace action must be suspend, resume or archive");
        }
        const status = action === "suspend" ? "suspended" : action === "resume" ? "active" : "archived";
        const changed = s.control.prepare("UPDATE workspaces SET status=?,version=version+1 WHERE id=? AND organization_id=? AND version=?").run(status, workspaceId, actor.organizationId, workspace.version);
        if (changed.changes !== 1) throw new BrainDomainError("CONFLICT", "workspace changed during the lifecycle operation");
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "workspace", aggregateId: workspaceId, eventType: `workspace.${action}d`, payload: { workspaceId, reason } });
        return { resourceId: workspaceId };
      },
    },
    // Full bundle logic lives in operations backup; the command records an intent resource.
    ...handlersFor(["workspace.export", "workspace.import"], {
      kind: "control",
      handle: ({ actor, workspaceId }) => ({ outcome: "queued", resourceId: workspaceId || actor.organizationId }),
    }),
  };
}
