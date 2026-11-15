// Relative imports: the browser project resolves no workspace packages from tests/.
import type { ActorContext, Mission } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { command, enrolledRunner, RESUMABLE_FEATURES } from "./interrupted-session";

const DIGEST = `sha256:${"a".repeat(64)}`;

/**
 * A mission with a two-member team whose two tasks a runner took (#113), reached through commands and the runner protocol: the writer's attempt
 * reported its usage and failed (the Governor then stored its failure class), the reviewer's attempt is still working and has its result judged
 * verified. The only seeded rows are that bundle and verdict, which a real evaluator run would leave (as `finishTask` does).
 */
export async function seedAgentActivity(brain: Brain, actor: ActorContext, workspaceId: string, key: string, title = "Draft and review the vendor summary"): Promise<{ missionId: string; writerAttemptId: string; reviewerAttemptId: string; writerRunId: string }> {
  const missionId = (await command(brain, actor, workspaceId, "mission.create", `${key}-create`, { title, intent: title, successCriteria: ["The summary is drafted and reviewed"], parkingThreshold: 1 })).resourceId ?? "";
  const team = [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }, { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" }];
  const tasks = [
    { id: "draft", title: "Write the draft", criteria: ["The draft is written"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } },
    { id: "review", title: "Review the draft", criteria: ["The draft is reviewed"], dependsOn: [], assignment: { kind: "agent", id: "reviewer", role: "specialist" }, workflowId: "operations-triage" },
  ];
  const planId = (await command(brain, actor, workspaceId, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks, team })).resourceId ?? "";
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await command(brain, actor, workspaceId, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);

  const runner = enrolledRunner(brain, actor, `runner-${key}`);
  // A workspace may have other queued work (the browser demo does): the runner takes it too, and only the attempts of this mission are used.
  const attempts: Array<{ offer: { attemptId: string; leaseId: string; jobFence: number }; memberId: string | undefined }> = [];
  for (let n = 0; attempts.length < 2 && n < 12; n++) {
    const offer = brain.jobProtocol.claim(runner, `claim-${key}-${n}`) as unknown as { attemptId: string; leaseId: string; jobFence: number } | null;
    if (!offer) throw new Error("the runner was offered no task");
    brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST, features: RESUMABLE_FEATURES } });
    let mine: { memberId: string | undefined } | undefined;
    try {
      const credential = brain.jobProtocol.sessionCredential(runner, offer.attemptId);
      if (credential.missionId === missionId) mine = { memberId: credential.memberId };
    } catch { /* an attempt that belongs to no mission */ }
    if (mine) { attempts.push({ offer, ...mine }); continue; }
    // Not this mission's: ended so the runner's capacity stays free for the two that are.
    brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", output: { error: "not part of this mission" }, jobFence: offer.jobFence, cleanupConfirmed: true });
    brain.jobProtocol.releaseReservation(offer.attemptId);
  }
  const writer = attempts.find((attempt) => attempt.memberId === "writer")!.offer;
  const reviewer = attempts.find((attempt) => attempt.memberId === "reviewer")!.offer;
  const usage = (offer: typeof writer, payload: Record<string, unknown>) => brain.jobProtocol.events(runner, offer.attemptId, {
    leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", model: "qwen-local", adapterDigest: DIGEST, features: RESUMABLE_FEATURES },
    events: [{ sequence: 1, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: "usage-1", sessionId: "s", attemptId: offer.attemptId, sequence: 1, occurredAt: new Date().toISOString(), kind: "usage", payload } }],
  });
  usage(writer, { usageId: "w1", inputTokens: 18_400, outputTokens: 2_300, microUsd: 0, accounting: "final-total" });
  usage(reviewer, { usageId: "r1", inputTokens: 6_100, outputTokens: 900, microUsd: 42_000, accounting: "final-total" });
  brain.jobProtocol.complete(runner, writer.attemptId, { result: "failed", output: { error: "the model stopped answering" }, jobFence: writer.jobFence, cleanupConfirmed: true });
  brain.jobProtocol.releaseReservation(writer.attemptId);
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  const writerRunId = (ws.prepare("SELECT run_id FROM mission_spend WHERE attempt_id=?").get(writer.attemptId) as { run_id: string }).run_id;
  brain.missions.recordRunFailure(actor.organizationId, workspaceId, writerRunId, "the model stopped answering");
  const judged = (attemptId: string, id: string, outcome: "verified" | "rejected") => {
    const digest = `sha256:${id.padEnd(64, "0")}`;
    ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', '{}', ?)").run(digest, `bundle-${id}`, `job-${id}`, attemptId, brain.store.now());
    ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms, finalized_at_ms) VALUES (?,?,?,?,?, '{}', ?, ?)").run(`verdict-${id}`, digest, `eval-${id}`, DIGEST, outcome, brain.store.now(), brain.store.now());
  };
  judged(reviewer.attemptId, `${key}-ok`, "verified");
  judged(writer.attemptId, `${key}-no`, "rejected");
  return { missionId, writerAttemptId: writer.attemptId, reviewerAttemptId: reviewer.attemptId, writerRunId };
}
