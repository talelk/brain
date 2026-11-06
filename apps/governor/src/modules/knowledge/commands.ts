import type { CommandHandlers } from "../../application/command-funnel";
import { requireWorkspaceRead } from "../../application/authz";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { activeRelease } from "../configuration/index";
import { readVerified } from "../artifacts/index";
import type { MemoryStore } from "./memory";

export interface KnowledgeCommandPorts {
  markKnowledgePublished(organizationId: string, workspaceId: string, sourceId: string): void;
  markKnowledgeRevoked(organizationId: string, workspaceId: string, sourceId: string): void;
}

/** Memory publication commands. Memory assets live in control.db. */
export function knowledgeCommands(store: Store, memory: MemoryStore, ports: KnowledgeCommandPorts): CommandHandlers {
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
        const scope = p["targetScope"] as { visibility: string; workspaceId?: string };
        const targetWorkspaceId = scope.visibility === "global-approved" ? null
          : scope.visibility === "workspace" ? String(scope.workspaceId)
          : (() => { throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `memory target scope ${scope.visibility} is not supported by the local store`); })();
        if (targetWorkspaceId) requireWorkspaceRead(s, actor, targetWorkspaceId);
        const id = memory.publish({
          organizationId: actor.organizationId, workspaceId: targetWorkspaceId,
          sourceId: String(p["candidateId"]), text: casBytes.toString("utf8"),
        });
        ports.markKnowledgePublished(actor.organizationId, sourceWorkspaceId, String(p["candidateId"]));
        return { resourceId: id };
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
