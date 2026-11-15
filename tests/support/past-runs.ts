import type { PlanTask } from "@brain/contracts";
import { DIGEST_A, workView, type TestWorld } from "../helpers";
import { command } from "./reuse";
import { finishTask } from "./finish-task";

// Completed runs for estimates from history (#132): each is a mission whose task is linked to a run of its own, claimed by a runner, settled
// in the usage ledger and finished (Done on verified evidence) through commands. Only the runner's usage report and the evidence are seeded.

const MINUTE = 60_000;
type Offer = { jobId: string; attemptId: string };
export interface PastRuns {
  readonly w: TestWorld;
  readonly runner: { runnerId: string; epoch: number; organizationId: string };
  /** Moves the Governor's clock forward while the attempt runs; without one the ledger's reservation time is moved back instead (a Governor on the system clock). */
  readonly advance?: (ms: number) => void;
  readonly count: { value: number };
}

/** A runner of the "fixture-tools" group able to take the jobs a past run queues. */
export function seedPastRunner(w: TestWorld, runnerId = "runner-past"): PastRuns["runner"] {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, 4)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3_600_000 * 24 * 365);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

/** One completed run of `task`, from the Play when `playId` is given (its starting plan, confirmed) else a plain mission; it takes `minutes` and settles `microUsd`. Returns the mission id. */
export async function pastRun(ctx: PastRuns, input: { playId?: string; task: PlanTask; minutes: number; microUsd: number }): Promise<string> {
  const { w, runner } = ctx;
  const n = ctx.count.value++;
  const key = `past${n}`;
  const run = async (commandType: string, id: string, payload: Record<string, unknown>, expectedVersion?: number) => command(w, w.owner, commandType, `${key}-${id}`, payload, expectedVersion);
  const version = async (missionId: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const missionId = (await run("mission.create", "create", input.playId
    ? { title: `Past ${n}`, playId: input.playId, autoStart: false }
    : { title: `Past ${n}`, intent: "Past work", successCriteria: ["done"], autoStart: false, budget: { memberCap: 3 } })).resourceId ?? "";
  const planId = input.playId ? (db.prepare("SELECT id FROM plan_versions WHERE mission_id=? ORDER BY revision").get(missionId) as { id: string }).id
    : (await run("plan.propose", "plan", { missionId, origin: "manual", tasks: [input.task] })).resourceId ?? "";
  await run("plan.confirm", "confirm", { planVersionId: planId }, await version(missionId));
  const item = (await workView(w)).items.find((entry) => entry.missionId === missionId && entry.planTaskId === input.task.id)!;
  w.brain.missions.linkExecution(w.owner, w.workspaceId, item.workItemId, `run-${key}`);
  const s = w.brain.store;
  const placement = { group: "fixture-tools", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], isolation: "ephemeral-container", resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 } };
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?,?,?,?,?, 'echo', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', 0, ?, ?, ?)`).run(`job-${key}`, w.org, w.workspaceId, `key-${key}`, `run-${key}`, w.brain.activeRelease(w.org)!.digest, JSON.stringify(placement), DIGEST_A, s.now(), s.now(), s.now() + 3_600_000);
  s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(`job-${key}`, "dispatch", "{}");
  s.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id=?").run(s.now(), runner.runnerId); // the runner kept heartbeating while the clock moved on
  s.control.prepare("UPDATE runner_capabilities SET observed_at_ms=?, expires_at_ms=? WHERE runner_id=?").run(s.now(), s.now() + 3_600_000, runner.runnerId);
  const offer = w.brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as Offer;
  if (offer?.jobId !== `job-${key}`) throw new Error(`the runner was not offered job-${key}`);
  ctx.advance?.(input.minutes * MINUTE);
  s.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(offer.attemptId, 1, JSON.stringify({ kind: "engine", payload: { kind: "usage", payload: { microUsd: input.microUsd, accounting: "final-total", inputTokens: 10, outputTokens: 5 } } }));
  w.brain.jobProtocol.releaseReservation(offer.attemptId);
  ctx.advance?.(7 * MINUTE); // the ledger settles later (on a read or a sweep): that wait is not the attempt's time
  if (!ctx.advance) db.prepare("UPDATE mission_spend SET created_at_ms=? WHERE attempt_id=?").run((s.control.prepare("SELECT released_at_ms AS at FROM capacity_reservations WHERE attempt_id=?").get(offer.attemptId) as { at: number }).at - input.minutes * MINUTE, offer.attemptId);
  const checks = input.task.criteria.map((criterion, index) => ({ criterionId: criterion, checkId: `c-${input.task.id}-${index}`, status: "passed" as const }));
  await finishTask(w, missionId, input.task.id, "0123456789abcdef"[n]!, checks);
  return missionId;
}
