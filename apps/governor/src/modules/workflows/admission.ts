import type { EvaluationAssignment, EvidenceBundle, JsonValue, StepCondition, Workflow } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { transitionState } from "../../domain/states";
import { NORMAL_JOB_PRIORITY } from "../../domain/work-priority";
import type { Db } from "../../infrastructure/persistence/open";
import { compileWorkflowGraph, pointerGet, resolveBinding } from "../configuration/index";
import { pinnedEvaluator } from "../evidence/index";
import type { WorkflowEnginePort, WorkflowHost } from "./engine-port";

/**
 * Step admission: the single place that decides which steps run and what
 * admitting a step of each kind does. `admitReadySteps` is the scheduler: every
 * step whose needs are met is admitted in the same pass, so independent steps
 * run at the same time (ADR 0043). It is idempotent on the step row, so whichever
 * caller reaches a step second only observes what the first did.
 *
 * - dispatch: queues the step's job
 * - gate: requests the approval and suspends the run
 * - subgraph: starts the child run and links it to the step
 * - steer: delivers the message and completes the step
 * - eval: nothing; evaluator jobs are admitted from submitted evidence
 */

/** The run a step belongs to, as admission needs it. */
export interface AdmissionRun {
  organizationId: string;
  workspaceId: string;
  runId: string;
  actorId: string;
  configDigest: string;
  input: JsonValue;
  workflow: Workflow;
}

export interface AdmissionPorts {
  readonly host: WorkflowHost;
  startChildRun(input: Parameters<WorkflowEnginePort["startRun"]>[0]): { runId: string };
}

/**
 * What the step is after admission: waiting on an external completion (a
 * job, approval, child run or evidence), or already finished.
 */
export type AdmissionState = "waiting" | "succeeded" | "failed" | "skipped";

const SETTLED: Record<string, AdmissionState> = { waiting: "waiting", running: "waiting", succeeded: "succeeded", failed: "failed", skipped: "skipped" };

/** The runner this run was pinned to at dispatch. */
function runnerPin(ws: Db, runId: string): string | undefined {
  const row = ws.prepare("SELECT runner_id FROM run_inputs WHERE run_id=?").get(runId) as { runner_id: string | null } | undefined;
  return row?.runner_id ?? undefined;
}

/** The job priority of the work this run serves; every job the run creates carries it. */
function runPriority(ws: Db, runId: string): number {
  const row = ws.prepare("SELECT priority FROM run_inputs WHERE run_id=?").get(runId) as { priority: number } | undefined;
  return row?.priority ?? NORMAL_JOB_PRIORITY;
}

/** What the scheduler does with a pending step, from the states of its needs and its `when` condition. */
type Readiness = "ready" | "wait" | "skip";

/**
 * A step whose needs all succeeded is ready, unless its `when` condition is false; one with a failed, cancelled or skipped need
 * is skipped, so a skip runs down every chain below it (ADR 0046). The condition reads the output of one of the step's own
 * ancestors, which is final once every need has succeeded.
 */
function readiness(step: Workflow["spec"]["jobs"][string], stateOf: (stepId: string) => string | undefined, outputs: Readonly<Record<string, JsonValue>>): Readiness {
  if (step.needs.some((need) => ["failed", "cancelled", "skipped"].includes(stateOf(need) ?? ""))) return "skip";
  if (!step.needs.every((need) => stateOf(need) === "succeeded")) return "wait";
  return step.when && !conditionHolds(step.when, outputs) ? "skip" : "ready";
}

/** A condition holds when its pointer resolves in the step's output (no `equals`) or resolves to exactly the `equals` value. */
function conditionHolds(condition: StepCondition, outputs: Readonly<Record<string, JsonValue>>): boolean {
  const source = outputs[condition.step];
  if (source === undefined) return false;
  let found: JsonValue;
  try { found = pointerGet(source, condition.pointer); } catch { return false; }
  return condition.equals === undefined || domainDigest("brain:when:v1", found) === domainDigest("brain:when:v1", condition.equals);
}

/** The outputs the run's steps have produced so far, by step id. */
export function readStepOutputs(ws: Db, runId: string): Record<string, JsonValue> {
  const outputs: Record<string, JsonValue> = {};
  for (const r of ws.prepare("SELECT step_id, output_json FROM step_outputs WHERE run_id=?").all(runId) as Array<{ step_id: string; output_json: string }>) {
    outputs[r.step_id] = JSON.parse(r.output_json) as JsonValue;
  }
  return outputs;
}

/**
 * The run's scheduler: admits every pending step whose needs are met, in one
 * pass and in the compiled order, and skips the pending steps a failed or
 * skipped need rules out. A step that completes synchronously (steer) makes its
 * dependents ready in the same pass; a failed step stops the pass. How many
 * attempts may run at once is not decided here: each admitted job waits in the
 * queue and the claim applies the mission's member cap and budget (ADR 0009, 0016).
 */
export function admitReadySteps(store: Store, ports: AdmissionPorts, run: AdmissionRun): void {
  const ws = store.workspaceDb(run.workspaceId, run.organizationId);
  const states = new Map((ws.prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(run.runId) as Array<{ step_id: string; state: string }>).map((r) => [r.step_id, r.state]));
  const outputs = readStepOutputs(ws, run.runId);
  for (const stepId of compileWorkflowGraph(run.workflow, run.runId)) {
    const declared = run.workflow.spec.jobs[stepId];
    if (!declared || states.get(stepId) !== "pending") continue;
    const verdict = readiness(declared, (id) => states.get(id), outputs);
    if (verdict === "skip") {
      ws.prepare("UPDATE workflow_steps SET state='skipped' WHERE run_id=? AND step_id=?").run(run.runId, stepId);
      states.set(stepId, "skipped");
      continue;
    }
    if (verdict === "wait" || declared.kind === "eval") continue; // an evaluation is admitted by the evidence it judges
    const admitted = admitStep(store, ports, run, stepId, outputs);
    states.set(stepId, admitted === "waiting" ? "running" : admitted);
    if (admitted === "failed") return;
  }
}

/**
 * Admits one step. A step already past `pending` is reported as it stands;
 * a pending step gets its kind's effect. `outputs` is the run's step outputs
 * and receives a synchronously completed step's output.
 */
export function admitStep(store: Store, ports: AdmissionPorts, run: AdmissionRun, stepId: string, outputs: Record<string, JsonValue>): AdmissionState {
  const s = store;
  const { organizationId, workspaceId, runId } = run;
  const ws = s.workspaceDb(workspaceId, organizationId);
  const row = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "workflow step not found");
  if (row.state !== "pending") return SETTLED[row.state] ?? "waiting";
  const step = run.workflow.spec.jobs[stepId];
  if (!step) throw new BrainDomainError("INVALID_CONTRACT", `missing step ${stepId}`);
  if (step.kind === "eval") return "waiting";
  if (step.kind === "steer") {
    const steered = steer(ports.host, run, step, outputs);
    ws.prepare("INSERT OR REPLACE INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(runId, stepId, JSON.stringify(steered.output));
    ws.prepare("UPDATE workflow_steps SET state=? WHERE run_id=? AND step_id=?").run(steered.ok ? "succeeded" : "failed", runId, stepId);
    outputs[stepId] = steered.output;
    return steered.ok ? "succeeded" : "failed";
  }
  const bound = resolveBinding(step.input as unknown as Record<string, unknown>, run.input, outputs);
  if (step.kind === "gate") {
    const subject = (bound["subject"] ?? bound) as JsonValue;
    const approvalId = ports.host.createApprovalForGate({
      organizationId, workspaceId, runId, stepId, subject,
      expiresAtMs: s.now() + ((step as { expiresAfterSeconds?: number }).expiresAfterSeconds ?? 3600) * 1000, requestedBy: run.actorId,
    });
    ws.prepare("UPDATE workflow_steps SET state='waiting', job_id=? WHERE run_id=? AND step_id=?").run(approvalId, runId, stepId);
    transitionState(ws, "run", runId, "suspended", { rawSet: ["wait_generation=wait_generation+1"], bumpVersion: true });
    return "waiting";
  }
  if (step.kind === "subgraph") {
    const ref = (step as { workflow?: { id?: string } }).workflow?.id;
    if (!ref) throw new BrainDomainError("INVALID_CONTRACT", `subgraph ${stepId} missing workflow ref`);
    const child = ports.host.loadWorkflow(organizationId, ref);
    const { runId: childRunId } = ports.startChildRun({
      organizationId, workspaceId, actorId: run.actorId, workflowId: ref, workflow: child.workflow,
      configDigest: child.configDigest, runInput: bound as unknown as JsonValue, executionKey: `${runId}:${stepId}:child`, priority: runPriority(ws, runId),
    });
    ws.prepare("INSERT OR REPLACE INTO engine_links(child_run_id, parent_run_id, parent_step_id, parent_workspace_id) VALUES (?,?,?,?)").run(childRunId, runId, stepId, workspaceId);
    ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(childRunId, runId, stepId);
    return "waiting";
  }
  const placement = "runsOn" in step ? (step as { runsOn: unknown }).runsOn : undefined;
  const effectClass = step.kind === "dispatch" && "effectClass" in step ? String((step as { effectClass: string }).effectClass) : "read";
  const executionDigest = domainDigest("brain:step-exec:v1", { stepId, bound } as unknown as JsonValue);
  const jobId = ports.host.createJobForStep({
    organizationId, workspaceId, runId, stepId,
    executionKey: `${runId}:${stepId}`, configDigest: run.configDigest, runnerId: runnerPin(ws, runId),
    placementJson: JSON.stringify(placement ?? {}),
    executionDigest, effectClass, kind: step.kind, priority: runPriority(ws, runId),
    payload: { step: step as unknown as JsonValue, input: bound as unknown as JsonValue },
  });
  ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(jobId, runId, stepId);
  return "waiting";
}

/**
 * Delivers a steer step: resolves its session and message bindings and
 * queues the message for that session. A session that is absent from the
 * workspace, or an empty message, fails the step instead of reporting a
 * steer nobody receives.
 */
function steer(host: WorkflowHost, run: AdmissionRun, step: Workflow["spec"]["jobs"][string], outputs: Readonly<Record<string, JsonValue>>): { output: JsonValue; ok: boolean } {
  const { sessionFrom, messageFrom } = step as { sessionFrom: unknown; messageFrom: unknown };
  try {
    const target = resolveBinding({ sessionId: sessionFrom, message: messageFrom }, run.input, outputs);
    const sessionId = target["sessionId"];
    const message = target["message"];
    if (typeof sessionId !== "string" || !sessionId) throw new BrainDomainError("INVALID_ARGUMENT", "steer step resolved no session id");
    if (typeof message !== "string" || !message.trim()) throw new BrainDomainError("INVALID_ARGUMENT", "steer step resolved no message");
    host.steerSession({ organizationId: run.organizationId, workspaceId: run.workspaceId, sessionId, message });
    return { output: { steered: true }, ok: true };
  } catch (error) {
    if (!(error instanceof BrainDomainError)) throw error;
    return { output: { steered: false, error: { code: error.code, message: error.message } }, ok: false };
  }
}

/**
 * Evaluator admission is evidence-triggered: an eval step's job is created
 * from the immutable bundles its needs submitted, never from step order
 * alone. Each pending eval step whose needs all have submitted evidence gets
 * one evaluator job pinned to those bundles.
 */
export function admitEvaluations(store: Store, host: WorkflowHost, run: AdmissionRun): void {
  const s = store;
  const { organizationId, workspaceId, runId, configDigest } = run;
  const ws = s.workspaceDb(workspaceId, organizationId);
  const outputs: Record<string, JsonValue> = {};
  for (const row of s.control.prepare("SELECT j.id,j.step_id,o.output_json FROM jobs j JOIN job_outputs o ON o.job_id=j.id WHERE j.workflow_run_id=? AND j.organization_id=? AND j.workspace_id=? AND j.state IN ('verifying','succeeded')").all(runId, organizationId, workspaceId) as Array<{ id: string; step_id: string; output_json: string }>) {
    outputs[row.step_id] = JSON.parse(row.output_json) as JsonValue;
  }
  for (const [stepId, step] of Object.entries(run.workflow.spec.jobs)) {
    if (step.kind !== "eval") continue;
    const row = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string };
    if (row.state !== "pending") continue;
    const bundles: EvidenceBundle[] = [];
    const digests: string[] = [];
    for (const need of step.needs) {
      const job = s.control.prepare("SELECT j.id,a.id AS attempt_id FROM jobs j JOIN job_attempts a ON a.job_id=j.id AND a.job_fence=j.job_fence WHERE j.organization_id=? AND j.workspace_id=? AND j.workflow_run_id=? AND j.step_id=? AND j.state='verifying' AND a.state='verifying'").get(organizationId, workspaceId, runId, need) as { id: string; attempt_id: string } | undefined;
      if (!job) break;
      const bundle = ws.prepare("SELECT digest,manifest_json FROM evidence_bundles WHERE job_id=? AND attempt_id=? AND state='submitted' ORDER BY created_at_ms DESC,digest LIMIT 1").get(job.id, job.attempt_id) as { digest: string; manifest_json: string } | undefined;
      if (!bundle) break;
      digests.push(bundle.digest); bundles.push(JSON.parse(bundle.manifest_json) as EvidenceBundle);
    }
    if (digests.length === 0 || digests.length !== step.needs.length) continue;
    const evaluator = pinnedEvaluator(s, organizationId, configDigest, step.evaluator);
    const levels = ["L1", "L2", "L3"] as const;
    const independence = levels[Math.max(levels.indexOf(step.independence), levels.indexOf(evaluator.spec.independence))]!;
    if (independence === "L3") throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "external L3 evaluator attestation is not installed");
    if (bundles.some((bundle) => evaluator.spec.requiredChecks.some((id) => !bundle.checks.some((c) => c.checkId === id)))) throw new BrainDomainError("EVIDENCE_MISSING", "submitted evidence omits a pinned evaluator check");
    const criteria: Record<string, string> = {};
    for (const bundle of bundles) for (const check of bundle.checks) {
      if (!evaluator.spec.requiredChecks.includes(check.checkId)) continue;
      if (criteria[check.checkId] && criteria[check.checkId] !== check.criterionId) throw new BrainDomainError("INVALID_CONTRACT", "one evaluator assignment cannot redefine a criterion across inputs");
      criteria[check.checkId] = check.criterionId;
    }
    const evaluation: EvaluationAssignment = { bundleDigests: digests, evaluatorRelease: step.evaluator, requiredChecks: evaluator.spec.requiredChecks, criteria, independence };
    const bound = resolveBinding(step.input as unknown as Record<string, unknown>, run.input, outputs);
    const executionDigest = domainDigest("brain:step-exec:v1", { stepId, bound, evaluation } as unknown as JsonValue);
    const jobId = host.createJobForStep({
      organizationId, workspaceId, runId, stepId, executionKey: `${runId}:${stepId}`, configDigest, runnerId: runnerPin(ws, runId),
      placementJson: JSON.stringify(step.runsOn), executionDigest, effectClass: "read", kind: "eval", priority: runPriority(ws, runId), payload: { step: step as unknown as JsonValue, input: bound, evaluation: evaluation as unknown as JsonValue },
    });
    ws.prepare("UPDATE workflow_steps SET state='running',job_id=? WHERE run_id=? AND step_id=? AND state='pending'").run(jobId, runId, stepId);
  }
}
