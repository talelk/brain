// Relative imports: the browser project resolves no workspace packages from tests/.
import type { ActorContext, CommandReceipt, Mission, SessionDetail } from "../../packages/contracts/src/index";
import { sha256Digest } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { observation, registerRunner } from "./runnerHello";

/**
 * An agent's attempt that stopped before it finished and left a checkpoint with the Governor (ADR 0063), reached the way a real one is:
 * through commands and the runner protocol (enroll, claim, ack, upload the saved conversation, complete with the checkpoint), never through
 * table writes.
 */
const DIGEST = `sha256:${"a".repeat(64)}`;
export const RESUMABLE_FEATURES = ["sessions", "checkpoint", "resume"];

export async function command(brain: Brain, actor: ActorContext, workspaceId: string, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

/** A runner that states what its engine can do, as the real one does at hello. */
export function enrolledRunner(brain: Brain, actor: ActorContext, runnerId: string) {
  const at = new Date().toISOString();
  const capabilities = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: RESUMABLE_FEATURES }])]
    .map((capability) => observation(capability, at, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  return { ...registerRunner(brain, actor, runnerId, { capabilities }), organizationId: actor.organizationId };
}

/**
 * A mission whose task a runner started (the next job the workspace has queued; in a fresh workspace that is this mission's) and could not finish: the attempt failed after saving the engine's conversation, and the task
 * stopped for a person (a mission that parks at the first failure keeps the Governor from starting it again by itself).
 */
export async function interruptedSession(brain: Brain, actor: ActorContext, workspaceId: string, runnerId: string, title: string, key: string): Promise<{ missionId: string; sessionId: string }> {
  const missionId = (await command(brain, actor, workspaceId, "mission.create", `${key}-create`, { title, intent: title, successCriteria: ["A one page summary exists"], parkingThreshold: 1 })).resourceId ?? "";
  const planId = (await command(brain, actor, workspaceId, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [{ id: "summary", title: "Write the one page summary", criteria: ["A one page summary exists"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await command(brain, actor, workspaceId, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);

  const runner = enrolledRunner(brain, actor, runnerId);
  const offer = brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as { attemptId: string; leaseId: string; jobFence: number } | null;
  if (!offer) throw new Error("the runner was offered no task");
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST, features: RESUMABLE_FEATURES } });
  // The engine's saved conversation goes to the Governor while the attempt is still running, as an artifact of that attempt.
  const conversation = new TextEncoder().encode(`{"type":"session","id":"${offer.attemptId}"}\n{"role":"user","content":"${title}"}\n`);
  const stored = brain.acceptAttemptArtifact(runner, offer.attemptId, { digest: sha256Digest(conversation), bytesBase64: Buffer.from(conversation).toString("base64"), mediaType: "application/x-ndjson" });
  brain.jobProtocol.complete(runner, offer.attemptId, {
    result: "failed", output: { error: "the model stopped answering" }, jobFence: offer.jobFence, cleanupConfirmed: true,
    checkpoint: {
      contractVersion: "brain.checkpoint/v2", attemptId: offer.attemptId, sourceRevision: DIGEST,
      engineState: { artifactId: stored.artifactId, digest: stored.digest, bytes: stored.bytes, mediaType: "application/x-ndjson", classification: "internal" },
      completedCriteria: [], failures: [], worktreeId: "read-only:workspace", eventSequence: 0, ownedResources: [], nextAction: "continue the saved conversation", createdAt: new Date().toISOString(),
    },
  });
  const sessions = ((await brain.executeQuery(actor, { queryType: "sessions.list", workspaceId } as never)) as unknown as { snapshot: { items: SessionDetail[] } }).snapshot.items;
  const session = sessions.find((entry) => entry.attemptId === offer.attemptId);
  if (!session) throw new Error("the attempt has no session");
  return { missionId, sessionId: session.sessionId };
}
