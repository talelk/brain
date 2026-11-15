import type { CommandHandlers } from "../../application/command-funnel";
import { requireWorkspaceRead } from "../../application/authz";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { activeRelease } from "../configuration/index";
import { readVerified } from "../artifacts/index";
import type { MemoryScope } from "@brain/contracts";
import type { MemoryPublishInput, MemoryStore } from "./memory";
import type { ScopeKind } from "./scope";
import type { ReuseService } from "./reuse";

export interface KnowledgeCommandPorts {
  markKnowledgePublished(organizationId: string, workspaceId: string, sourceId: string, scope: ScopeKind): void;
  markKnowledgeRevoked(organizationId: string, workspaceId: string, sourceId: string): void;
}

/**
 * Where a reviewed publication lands (#135, ADR 0056). A team scope names a mission of the source workspace; a private scope names the
 * publisher, so nobody plants private memory in someone else's view. When the candidate is a knowledge asset, the scope must be the one
 * its own record gives (its mission's team, its author), so the Knowledge page and the memory store never disagree.
 */
function publicationTarget(s: Store, actor: { actorId: string; organizationId: string }, scope: MemoryScope, sourceWorkspaceId: string, candidateId: string): Pick<MemoryPublishInput, "workspaceId" | "visibility" | "teamId" | "ownerId"> {
  if (scope.visibility === "global-approved") return { workspaceId: null, visibility: "global-approved" };
  if (scope.visibility === "workspace") return { workspaceId: scope.workspaceId, visibility: "workspace" };
  const db = s.workspaceDb(sourceWorkspaceId, actor.organizationId);
  const asset = db.prepare("SELECT mission_id, producer_id FROM knowledge_assets WHERE id=?").get(candidateId) as { mission_id: string | null; producer_id: string | null } | undefined;
  if (scope.visibility === "team") {
    if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(scope.teamId)) throw new BrainDomainError("NOT_FOUND", "the team's mission is not in the source workspace");
    if (asset && asset.mission_id !== scope.teamId) throw new BrainDomainError("CONFLICT", "a knowledge asset is shared with the team of its own mission");
    return { workspaceId: sourceWorkspaceId, visibility: "team", teamId: scope.teamId };
  }
  if (scope.ownerId !== actor.actorId) throw new BrainDomainError("FORBIDDEN", "private memory is published for yourself only");
  if (asset && asset.producer_id !== scope.ownerId) throw new BrainDomainError("CONFLICT", "a knowledge asset is private to its author");
  return { workspaceId: scope.workspaceId, visibility: "private", ownerId: scope.ownerId };
}

/** Memory publication commands. Memory assets live in control.db. */
export function knowledgeCommands(store: Store, memory: MemoryStore, reuse: ReuseService, ports: KnowledgeCommandPorts): CommandHandlers {
  const s = store;
  return {
    "memory.publish": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        // Reviewed publication (T39): content is a digest-pinned CAS artifact,
        // backed by existing evidence artifacts, reviewed by a *different*
        // principal, under a redaction profile declared in the active release.
        const p = cmd.payload;
        const content = p["content"] as { artifactId: string; digest: string; bytes: number };
        const sourceWorkspaceId = String(p["sourceWorkspaceId"]);
        const reviewerId = String(p["reviewerId"]);
        if (reviewerId === actor.actorId) throw new BrainDomainError("FORBIDDEN", "memory reviewer must differ from the publisher");
        const reviewer = s.control.prepare("SELECT 1 FROM principals WHERE id=? AND organization_id=? AND disabled_at_ms IS NULL").get(reviewerId, actor.organizationId);
        if (!reviewer) throw new BrainDomainError("NOT_FOUND", "memory reviewer is not a principal in this organization");
        requireWorkspaceRead(s, actor, sourceWorkspaceId);
        const sourceWs = s.workspaceDb(sourceWorkspaceId, actor.organizationId);
        const contentRow = sourceWs.prepare("SELECT id, bytes FROM artifacts WHERE digest=?").get(content.digest) as { id: string; bytes: number } | undefined;
        if (!contentRow || contentRow.bytes !== content.bytes) throw new BrainDomainError("NOT_FOUND", "memory content artifact not found in source workspace");
        for (const evidenceDigest of (p["evidenceDigests"] as string[])) {
          if (!sourceWs.prepare("SELECT 1 FROM artifacts WHERE digest=?").get(evidenceDigest)) {
            throw new BrainDomainError("EVIDENCE_MISSING", `evidence artifact ${evidenceDigest} not found in source workspace`);
          }
        }
        const profile = p["redactionProfile"] as { id: string; digest: string };
        const rel = activeRelease(s, actor.organizationId);
        const relDocs = rel ? (((JSON.parse(rel.manifest) as { manifest?: { documents?: Array<Record<string, unknown>> } }).manifest?.documents) ?? []) : [];
        if (!relDocs.some((d) => d["id"] === profile.id && d["digest"] === profile.digest)) {
          throw new BrainDomainError("INVALID_CONTRACT", "redaction profile is not declared in the active release");
        }
        const casBytes = Buffer.from(readVerified(s, content.digest));
        if (casBytes.length > 256 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "memory content exceeds 256 KiB");
        const scope = p["targetScope"] as MemoryScope;
        const candidateId = String(p["candidateId"]);
        const target = publicationTarget(s, actor, scope, sourceWorkspaceId, candidateId);
        if (target.workspaceId) requireWorkspaceRead(s, actor, target.workspaceId);
        const id = memory.publish({
          organizationId: actor.organizationId, ...target,
          sourceId: candidateId, text: casBytes.toString("utf8"),
        });
        ports.markKnowledgePublished(actor.organizationId, sourceWorkspaceId, candidateId, scope.visibility === "team" || scope.visibility === "private" ? scope.visibility : "workspace");
        return { resourceId: id };
      },
    },
    // A person keeps or drops one suggested item for one mission (#68, #70). Dropping is audited by the command record.
    "mission.reuse.decide": {
      kind: "workspace",
      handle: ({ actor, cmd, workspaceId }) => {
        const missionId = String(cmd.payload["missionId"]);
        reuse.decide(actor, workspaceId, missionId, String(cmd.payload["itemRef"]), cmd.payload["decision"] === "keep" ? "keep" : "drop");
        return { resourceId: missionId };
      },
    },
    "memory.revoke": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const sourceId = String(cmd.payload["sourceId"]);
        memory.revoke(actor.organizationId, workspaceId, sourceId);
        ports.markKnowledgeRevoked(actor.organizationId, workspaceId, sourceId);
        return { resourceId: sourceId };
      },
    },
  };
}
