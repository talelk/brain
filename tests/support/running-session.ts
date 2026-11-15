// Relative imports: the browser project resolves no workspace packages from tests/.
import type { ActorContext, Mission, SessionDetail } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { command, enrolledRunner } from "./interrupted-session";

/**
 * A mission task a runner started and is still working on (ADR 0058), reached the way a real one is: through commands and the runner protocol
 * (enroll, claim, ack), never through table writes. `features` is what the runner says its engine can do; "pause" means it can stop at a turn boundary.
 */
const DIGEST = `sha256:${"a".repeat(64)}`;
export const PAUSABLE_FEATURES = ["sessions", "steer", "pause"];

export interface RunningSession { missionId: string; sessionId: string; runner: { runnerId: string; epoch: number; organizationId: string }; offer: { attemptId: string; leaseId: string; jobFence: number }; nextSequence: () => number }

export async function runningSession(brain: Brain, actor: ActorContext, workspaceId: string, runnerId: string, title: string, key: string, features: string[]): Promise<RunningSession> {
  const missionId = (await command(brain, actor, workspaceId, "mission.create", `${key}-create`, { title, intent: title, successCriteria: ["A one page summary exists"] })).resourceId ?? "";
  const planId = (await command(brain, actor, workspaceId, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [{ id: "summary", title: "Write the one page summary", criteria: ["A one page summary exists"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await command(brain, actor, workspaceId, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, version);
  const runner = enrolledRunner(brain, actor, runnerId);
  const offer = brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as { attemptId: string; leaseId: string; jobFence: number } | null;
  if (!offer) throw new Error("the runner was offered no task");
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "pi", adapterDigest: DIGEST, features } });
  const sessions = ((await brain.executeQuery(actor, { queryType: "sessions.list", workspaceId } as never)) as unknown as { snapshot: { items: SessionDetail[] } }).snapshot.items;
  const session = sessions.find((entry) => entry.attemptId === offer.attemptId);
  if (!session) throw new Error("the attempt has no session");
  let sequence = 0;
  return { missionId, sessionId: session.sessionId, runner, offer, nextSequence: () => ++sequence };
}

/** What the runner holding the attempt is told on its next heartbeat. */
let beat = 0;
export function heartbeatCommands(brain: Brain, running: RunningSession): string[] {
  return brain.jobProtocol.heartbeat(running.runner, { sequence: Date.now() * 100 + (beat++ % 100), health: "healthy" }).commands
    .filter((entry) => entry.attemptId === running.offer.attemptId).map((entry) => entry.type);
}

/** The runner reports that its engine is held at a turn boundary ("session-paused") or running again ("session-continued"). */
export function runnerReports(brain: Brain, running: RunningSession, phase: "session-paused" | "session-continued"): void {
  brain.jobProtocol.events(running.runner, running.offer.attemptId, { leaseId: running.offer.leaseId, jobFence: running.offer.jobFence, events: [{ sequence: running.nextSequence(), kind: "progress", payload: { phase } }] });
}
