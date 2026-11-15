import type { ActorContext } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { activeReleaseRecord } from "../../apps/governor/src/modules/configuration/index";
import { effectInputDigest } from "../../apps/governor/src/modules/governance/effects";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** The change this approval proposes: two files, one of them several lines, so the diff has something to read. */
export const CHANGE = {
  title: "Raise the demo-app memory limit",
  branch: "brain/raise-demo-app-memory",
  files: [
    { path: "docs/demo-app/limits.md", content: "# Demo app limits\n\nmemory: 768m\ncpu: 1\n" },
    { path: "deploy/demo-app.env", content: "MEMORY_LIMIT=768m\n" },
  ],
};

/**
 * A pending approval of a pull-request call the way the effect gate records one: the active release's own `git.open-pr` tool (so its
 * declared rollback is read from the pinned Tool document), the files as arguments, and the origin of a run that serves a task. The
 * approval goes through `approval.request`, which checks the origin against the Governor's own links.
 */
export async function seedChangeApproval(brain: Brain, actor: ActorContext, workspaceId: string, input: { runId: string; key: string }): Promise<{ approvalId: string; title: string }> {
  const release = activeReleaseRecord(brain.store, actor.organizationId);
  const tool = release?.release.manifest.tools?.find((candidate) => candidate.id === "git.open-pr");
  if (!release || !tool) throw new Error("change approval seed: the active release has no git.open-pr tool");
  const link = brain.store.workspaceDb(workspaceId, actor.organizationId).prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(input.runId) as { mission_id: string; work_item_id: string };
  const args = { title: CHANGE.title, body: "The container was killed for memory twice today.", branch: CHANGE.branch, files: CHANGE.files };
  const subject = {
    organizationId: actor.organizationId, workspaceId, operation: "effect.git.open-pr", tool: { id: tool.id, digest: tool.digest }, inputDigest: effectInputDigest(args),
    target: { targetId: "tool:git.open-pr", environmentId: "local", preconditionDigest: tool.digest }, artifactDigest: tool.digest, policyDigest: DIGEST, configDigest: release.digest,
    effectBounds: { summary: `Open a pull request "${CHANGE.title}" from branch ${CHANGE.branch} with ${CHANGE.files.length} changed file(s)`, arguments: args, once: true },
    expiresAt: new Date(brain.store.now() + 3600_000).toISOString(), nonce: input.key,
    origin: { runId: input.runId, missionId: link.mission_id, workItemId: link.work_item_id },
  };
  const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${input.key}`, commandType: "approval.request", workspaceId, idempotencyKey: input.key, payload: { subject } } as never, input.key);
  if (!receipt.accepted) throw new Error("change approval seed: approval.request was refused");
  // The effect gate's requester is the platform, never a person (ADR 0024), so the signed-in owner may decide this one; a command records its caller.
  brain.store.control.prepare("UPDATE approval_requests SET requested_by='system:effect-call' WHERE id=?").run(receipt.resourceId);
  return { approvalId: receipt.resourceId ?? "", title: CHANGE.title };
}
