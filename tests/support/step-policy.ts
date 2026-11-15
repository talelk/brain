import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetryPolicy } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { parseRestrictedYaml } from "../../apps/governor/src/modules/configuration/compiler";
import { goldenDocs, setupWorld, DIGEST_A } from "../helpers";

// Tests of what a step declares about running (ADR 0046): the golden release's one-step fixture workflow, with the declaration under test
// on its `echo` step, a Governor on a clock the test moves, and a runner that claims and completes attempts through the runner protocol.

export type World = ReturnType<typeof setupWorld>;
export type Runner = { runnerId: string; epoch: number; organizationId: string };
export type Offer = { jobId: string; attemptId: string; leaseId: string; jobFence: number };

export function controlledClock(start = Date.now()): { clock: { nowMs: () => number; monotonicMs: () => number }; advance: (ms: number) => void } {
  let now = start;
  return { clock: { nowMs: () => now, monotonicMs: () => now }, advance: (ms) => { now += ms; } };
}

export const readRetry = (maxAttempts: number, classes: RetryPolicy["classes"] = ["transient-read"]): RetryPolicy => ({ maxAttempts, classes, initialDelayMs: 1000, maxDelayMs: 4000 });

/** A release whose fixture workflow is the `echo` step alone, carrying the declared `retry` and `timeoutSeconds`, active in a fresh world. */
export function policyWorld(clock: { nowMs: () => number; monotonicMs: () => number }, declared: { retry?: RetryPolicy; timeoutSeconds?: number }, dataDir = mkdtempSync(join(tmpdir(), "brain-test-"))): World {
  const w = setupWorld(new Brain({ dataDir, allowTestActor: true, clock }));
  const docs = goldenDocs().map((doc) => {
    if (!doc.path.endsWith("fixture-workflow.yaml")) return doc;
    const workflow = parseRestrictedYaml(doc.text, doc.path) as { spec: { jobs: Record<string, Record<string, unknown>>; outputs: unknown } };
    const echo = { ...workflow.spec.jobs["echo"]!, ...(declared.retry ? { retry: declared.retry } : {}), ...(declared.timeoutSeconds ? { timeoutSeconds: declared.timeoutSeconds } : {}) };
    workflow.spec.jobs = { echo };
    workflow.spec.outputs = { message: { source: "job", jobId: "echo", pointer: "" } };
    return { path: doc.path, text: JSON.stringify(workflow, null, 2) + "\n" };
  });
  const { digest } = w.brain.stageRelease(w.owner, docs, "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  w.brain.activateRelease(w.owner, digest);
  return w;
}

export function seedRunner(w: World, runnerId: string): Runner {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 4)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 30 * 86_400_000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

/** Dispatches the fixture workflow through the command boundary; returns the run id. */
export async function dispatchFixture(w: World, key: string): Promise<string> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  const { receipt } = await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  return receipt.resourceId!;
}

/** The runner claims the queued job and starts its attempt; null when nothing is offered. */
export function startAttempt(w: World, runner: Runner, requestId: string): Offer | null {
  const offer = w.brain.jobProtocol.claim(runner, requestId) as unknown as Offer | null;
  if (!offer) return null;
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  return offer;
}

export const failAttempt = (w: World, runner: Runner, offer: Offer, error: string) =>
  w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", output: { error }, jobFence: offer.jobFence, cleanupConfirmed: true });

export const jobRow = (w: World | Brain, jobId: string) => ((w instanceof Brain ? w : w.brain).store.control.prepare("SELECT state, queue_reason, attempt_counter, step_failures, ready_at_ms FROM jobs WHERE id=?").get(jobId) as
  { state: string; queue_reason: string | null; attempt_counter: number; step_failures: number; ready_at_ms: number });
export const attemptsOf = (brain: Brain, jobId: string) => brain.store.control.prepare("SELECT attempt_no AS no, state, failure_reason AS reason FROM job_attempts WHERE job_id=? ORDER BY attempt_no").all(jobId) as Array<{ no: number; state: string; reason: string | null }>;
export const runStateOf = (brain: Brain, w: World, runId: string) => (brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;
export const stepStatesOf = (brain: Brain, w: World, runId: string) => Object.fromEntries((brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ step_id: string; state: string }>).map((r) => [r.step_id, r.state]));
