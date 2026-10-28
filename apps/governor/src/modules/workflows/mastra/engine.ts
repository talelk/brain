import { payloadValidator } from "@brain/contracts/validate";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EvaluationAssignment, EvidenceBundle, JsonValue, Workflow } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import { BrainDomainError } from "../../../domain/errors";
import { compileWorkflowGraph, resolveBinding } from "../../configuration/index";
import type { Store } from "../../../application/store";
import type { WorkflowEnginePort, WorkflowHost } from "../engine-port";
import { pinnedEvaluator } from "../../evidence/index";

// Mastra-backed WorkflowEnginePort (T29/T30). Brain tables remain the
// operational authority (workflow_runs/steps/outputs); Mastra owns run
// progression and durable suspend/resume snapshots in its own LibSQL store.
// Every externally-effecting step suspends in Mastra until Brain completes
// the corresponding job/approval, so a process restart loses nothing: a
// fresh engine rehydrates the Mastra run by its deterministic runId and any
// completion recorded before the step suspended is replayed from the durable
// engine_resumes table (early-wake safe).
interface MastraRun {
  start: (opts: { inputData: unknown }) => Promise<{ status: string }>;
  resume: (opts: { step: string; resumeData: unknown }) => Promise<{ status: string }>;
  cancel?: () => Promise<void>;
}

interface ResumeRecord { output: JsonValue; ok: boolean }

interface SharedMastra {
  mastra: {
    addWorkflow: (workflow: unknown, key: string) => void;
    getWorkflow: (id: string) => { createRun: (opts?: { runId?: string }) => Promise<MastraRun> };
  };
  createWorkflow: typeof import("@mastra/core/workflows").createWorkflow;
  createStep: typeof import("@mastra/core/workflows").createStep;
}

export class MastraWorkflowEngine implements WorkflowEnginePort {
  readonly engineId = "mastra";
  private readonly runs = new Map<string, Promise<MastraRun>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private sharedMastra?: Promise<SharedMastra>;
  private readonly loweredWorkflows = new Map<string, Promise<unknown>>();
  private readonly runScopes = new Map<string, { organizationId: string; workspaceId: string }>();

  constructor(
    private readonly store: Store,
    private readonly host: WorkflowHost,
    private readonly storageDir: string,
  ) {
    mkdirSync(storageDir, { recursive: true });
  }

  startRun(input: {
    organizationId: string; workspaceId: string; actorId: string;
    workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string;
  }): { runId: string } {
    // Synchronous admission (caller contract: a claim immediately after
    // dispatch sees the first job/approval). Admission is implemented here,
    // not delegated: persist run+steps, admit the first ready step, then let
    // the Mastra run drive progression from those exact durable rows. Step
    // execution is idempotent against admitted rows.
    const s = this.store;
    this.validatePayload(input.organizationId, input.configDigest, input.workflow.spec.inputSchemaRef, input.runInput);
    s.assertWorkspaceActive(input.workspaceId, input.organizationId);
    const ws = s.workspaceDb(input.workspaceId, input.organizationId);
    const existing = ws.prepare("SELECT id FROM workflow_runs WHERE execution_key=?").get(input.executionKey) as { id: string } | undefined;
    if (existing) return { runId: existing.id };
    const order = compileWorkflowGraph(input.workflow, input.workflowId);
    const runId = s.id("run");
    const workflowDigest = domainDigest("brain:workflow:v1", input.workflow as unknown as JsonValue);
    const inputDigest = domainDigest("brain:run-input:v1", input.runInput);
    s.inTx(ws, () => {
      ws.prepare(`INSERT INTO workflow_runs(id, execution_key, config_digest, workflow_digest, adapter_digest, engine_run_id, state, input_digest, created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, input.executionKey, input.configDigest, workflowDigest, domainDigest("brain:engine:v1", { engine: "mastra" }), runId, "running", inputDigest, s.now());
      ws.prepare("CREATE TABLE IF NOT EXISTS run_inputs(run_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, workflow_json TEXT NOT NULL, actor_id TEXT NOT NULL) STRICT").run();
      ws.prepare("INSERT INTO run_inputs(run_id, input_json, workflow_json, actor_id) VALUES (?,?,?,?)")
        .run(runId, JSON.stringify(input.runInput), JSON.stringify(input.workflow), input.actorId);
      for (const stepId of order) {
        ws.prepare("INSERT INTO workflow_steps(run_id, step_id, execution_key, state) VALUES (?,?,?, 'pending')")
          .run(runId, stepId, `${input.executionKey}:${stepId}`);
      }
    });
    this.admit(input.organizationId, input.workspaceId, runId);
    this.track(this.drive(input.organizationId, input.workspaceId, runId, "start"));
    return { runId };
  }

  completeStep(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void {
    if (ok) {
      const run = this.loadRun(workspaceId, organizationId, runId);
      const step = run.workflow.spec.jobs[stepId];
      if (step && step.kind === "dispatch") {
        try { this.validatePayload(organizationId, run.configDigest, step.outputSchemaRef, output); }
        catch (e) { ok = false; output = { error: e instanceof Error ? e.message : "invalid output" }; }
      }
    }
    this.recordResume(organizationId, workspaceId, runId, stepId, { output, ok });
    this.applyCompletionSync(organizationId, workspaceId, runId, stepId, output, ok);
    if (ok) this.admit(organizationId, workspaceId, runId);
    this.track(this.drive(organizationId, workspaceId, runId, "resume", stepId));
  }

  private validatePayload(organizationId: string, configDigest: string, ref: string, value: JsonValue): void {
    const row = this.store.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(configDigest, organizationId) as { manifest_json: string } | undefined;
    const schemas = row ? (JSON.parse(row.manifest_json) as { schemas?: Record<string, JsonValue> }).schemas : undefined;
    const schema = schemas?.[ref];
    if (!schema) return;
    const result = payloadValidator(schema as object)(value);
    if (!result.ok) throw new BrainDomainError("INVALID_ARGUMENT", `${ref}: ${result.errors.join("; ")}`);
  }

  wakeGate(organizationId: string, workspaceId: string, approvalId: string, approved: boolean): void {
    const s = this.store;
    s.assertWorkspaceActive(workspaceId, organizationId);
    const ws = s.workspaceDb(workspaceId, organizationId);
    const row = ws.prepare("SELECT run_id, step_id FROM workflow_steps WHERE job_id=? AND state='waiting'").get(approvalId) as { run_id: string; step_id: string } | undefined;
    if (!row) return;
    this.recordResume(organizationId, workspaceId, row.run_id, row.step_id, { output: { approved }, ok: approved });
    s.inTx(ws, () => {
      ws.prepare("UPDATE workflow_steps SET state=? WHERE run_id=? AND step_id=?").run(approved ? "succeeded" : "failed", row.run_id, row.step_id);
      ws.prepare("CREATE TABLE IF NOT EXISTS step_outputs(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT").run();
      ws.prepare("INSERT OR REPLACE INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(row.run_id, row.step_id, JSON.stringify({ approved }));
      ws.prepare("UPDATE workflow_runs SET state=?, version=version+1 WHERE id=?").run(approved ? "running" : "failed", row.run_id);
    });
    if (approved) this.admit(organizationId, workspaceId, row.run_id);
    this.track(this.drive(organizationId, workspaceId, row.run_id, "resume", row.step_id));
  }

  cancelRun(organizationId: string, workspaceId: string, runId: string): void {
    const ws = this.store.workspaceDb(workspaceId, organizationId);
    ws.prepare("UPDATE workflow_runs SET state='cancelled', version=version+1 WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')").run(runId);
    ws.prepare("UPDATE workflow_steps SET state='skipped' WHERE run_id=? AND state='pending'").run(runId);
    const pending = this.runs.get(runId);
    if (pending) this.track(pending.then((run) => run.cancel?.()).catch(() => undefined));
  }

  // Synchronous completion write (immutable, digest-checked) so callers
  // observing the run immediately after a completion see final state.
  private applyCompletionSync(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void {
    const s = this.store;
    s.assertWorkspaceActive(workspaceId, organizationId);
    const ws = s.workspaceDb(workspaceId, organizationId);
    ws.prepare("CREATE TABLE IF NOT EXISTS step_outputs(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT").run();
    s.inTx(ws, () => {
      const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string } | undefined;
      if (!run || ["cancelled", "failed", "succeeded", "partial"].includes(run.state)) return;
      const prior = ws.prepare("SELECT state,output_digest FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string; output_digest: string | null } | undefined;
      if (!prior) throw new BrainDomainError("NOT_FOUND", "workflow step not found");
      const digest = domainDigest("brain:step-output:v1", output);
      if (prior.output_digest) {
        if (prior.output_digest !== digest || prior.state !== (ok ? "succeeded" : "failed")) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "workflow completion is immutable");
        return;
      }
      ws.prepare("INSERT OR REPLACE INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(runId, stepId, JSON.stringify(output));
      ws.prepare("UPDATE workflow_steps SET state=?,output_digest=? WHERE run_id=? AND step_id=?").run(ok ? "succeeded" : "failed", digest, runId, stepId);
      if (!ok) ws.prepare("UPDATE workflow_runs SET state='failed', version=version+1 WHERE id=?").run(runId);
    });
  }

  // Admit the next ready step (one active step at a time, deterministic
  // order): create its Brain job/approval/child run synchronously. The
  // Mastra step for it will find the admitted row and suspend.
  private admit(organizationId: string, workspaceId: string, runId: string): void {
    const s = this.store;
    s.assertWorkspaceActive(workspaceId, organizationId);
    const ws = s.workspaceDb(workspaceId, organizationId);
    const { workflow, input, actorId, configDigest, state } = this.loadRun(workspaceId, organizationId, runId);
    if (["succeeded", "failed", "cancelled", "partial"].includes(state)) return;
    const order = compileWorkflowGraph(workflow, runId);
    const steps = ws.prepare("SELECT step_id, state, job_id, output_digest FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ step_id: string; state: string; job_id: string | null; output_digest: string | null }>;
    const byId = new Map(steps.map((r) => [r.step_id, r]));
    const outputs = this.readOutputs(workspaceId, organizationId, runId);
    for (const stepId of order) {
      const row = byId.get(stepId);
      const job = workflow.spec.jobs[stepId];
      if (!row || !job) continue;
      if (row.state === "succeeded") continue;
      const needsDone = job.needs.every((n) => byId.get(n)?.state === "succeeded");
      const needsFailed = job.needs.some((n) => ["failed", "cancelled", "skipped"].includes(byId.get(n)?.state ?? ""));
      if (needsFailed && row.state === "pending") {
        ws.prepare("UPDATE workflow_steps SET state='skipped' WHERE run_id=? AND step_id=?").run(runId, stepId);
        byId.set(stepId, { ...row, state: "skipped" });
        continue;
      }
      if (!needsDone) continue;
      if (row.state !== "pending") continue;
      if (job.kind === "eval") continue; // admitted by evidenceSubmitted
      const bound = resolveBinding(job.input as unknown as Record<string, unknown>, input, outputs);
      if (job.kind === "gate") {
        const subject = (bound["subject"] ?? bound) as JsonValue;
        const approvalId = this.host.createApprovalForGate({
          organizationId, workspaceId, runId, stepId, subject,
          expiresAtMs: s.now() + ((job as { expiresAfterSeconds?: number }).expiresAfterSeconds ?? 3600) * 1000, requestedBy: actorId,
        });
        ws.prepare("UPDATE workflow_steps SET state='waiting', job_id=? WHERE run_id=? AND step_id=?").run(approvalId, runId, stepId);
        ws.prepare("UPDATE workflow_runs SET state='suspended', wait_generation=wait_generation+1, version=version+1 WHERE id=?").run(runId);
        return;
      }
      if (job.kind === "subgraph") {
        const ref = (job as { workflow?: { id?: string } }).workflow?.id;
        if (!ref) throw new BrainDomainError("INVALID_CONTRACT", `subgraph ${stepId} missing workflow ref`);
        const child = this.host.loadWorkflow(organizationId, ref);
        const { runId: childRunId } = this.startRun({
          organizationId, workspaceId, actorId, workflowId: ref, workflow: child.workflow,
          configDigest: child.configDigest, runInput: bound as unknown as JsonValue, executionKey: `${runId}:${stepId}:child`,
        });
        ws.prepare(`CREATE TABLE IF NOT EXISTS engine_links(child_run_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, parent_step_id TEXT NOT NULL, parent_workspace_id TEXT NOT NULL) STRICT`).run();
        ws.prepare("INSERT OR REPLACE INTO engine_links(child_run_id, parent_run_id, parent_step_id, parent_workspace_id) VALUES (?,?,?,?)").run(childRunId, runId, stepId, workspaceId);
        ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(childRunId, runId, stepId);
        return;
      }
      if (job.kind === "steer") {
        this.host.recordSteer({ organizationId, workspaceId, runId, stepId, payload: bound as unknown as JsonValue });
        ws.prepare("INSERT OR REPLACE INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(runId, stepId, JSON.stringify({ steered: true }));
        ws.prepare("UPDATE workflow_steps SET state='succeeded' WHERE run_id=? AND step_id=?").run(runId, stepId);
        outputs[stepId] = { steered: true };
        byId.set(stepId, { ...row, state: "succeeded" });
        continue;
      }
      const placement = "runsOn" in job ? (job as { runsOn: unknown }).runsOn : undefined;
      const effectClass = job.kind === "dispatch" && "effectClass" in job ? String((job as { effectClass: string }).effectClass) : "read";
      const executionDigest = domainDigest("brain:step-exec:v1", { stepId, bound } as unknown as JsonValue);
      const jobId = this.host.createJobForStep({
        organizationId, workspaceId, runId, stepId,
        executionKey: `${runId}:${stepId}`, configDigest,
        placementJson: JSON.stringify(placement ?? {}),
        executionDigest, effectClass, kind: job.kind,
        payload: { step: job as unknown as JsonValue, input: bound as unknown as JsonValue },
      });
      ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(jobId, runId, stepId);
      return;
    }
    const refreshed = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ state: string }>;
    if (refreshed.length > 0 && refreshed.every((r) => r.state === "succeeded" || r.state === "skipped")) {
      const anySkipped = refreshed.some((r) => r.state === "skipped");
      ws.prepare("UPDATE workflow_runs SET state=?, version=version+1 WHERE id=?").run(anySkipped ? "partial" : "succeeded", runId);
    }
  }

  // Eval admission is evidence-triggered: evaluator jobs are created from
  // submitted immutable bundles, never from step order alone.
  evidenceSubmitted(organizationId: string, workspaceId: string, runId: string): void {
    const s = this.store;
    s.assertWorkspaceActive(workspaceId, organizationId);
    const ws = s.workspaceDb(workspaceId, organizationId);
    const { workflow, input, state, configDigest } = this.loadRun(workspaceId, organizationId, runId);
    if (["cancelled", "failed", "succeeded", "partial"].includes(state)) return;
    const outputs: Record<string, JsonValue> = {};
    for (const row of s.control.prepare("SELECT j.id,j.step_id,o.output_json FROM jobs j JOIN job_outputs o ON o.job_id=j.id WHERE j.workflow_run_id=? AND j.organization_id=? AND j.workspace_id=? AND j.state IN ('verifying','succeeded')").all(runId, organizationId, workspaceId) as Array<{ id: string; step_id: string; output_json: string }>) {
      outputs[row.step_id] = JSON.parse(row.output_json) as JsonValue;
    }
    for (const [stepId, step] of Object.entries(workflow.spec.jobs)) {
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
      const bound = resolveBinding(step.input as unknown as Record<string, unknown>, input, outputs);
      const executionDigest = domainDigest("brain:step-exec:v1", { stepId, bound, evaluation } as unknown as JsonValue);
      const jobId = this.host.createJobForStep({
        organizationId, workspaceId, runId, stepId, executionKey: `${runId}:${stepId}`, configDigest,
        placementJson: JSON.stringify(step.runsOn), executionDigest, effectClass: "read", kind: "eval", payload: { step: step as unknown as JsonValue, input: bound, evaluation: evaluation as unknown as JsonValue },
      });
      ws.prepare("UPDATE workflow_steps SET state='running',job_id=? WHERE run_id=? AND step_id=? AND state='pending'").run(jobId, runId, stepId);
    }
  }

  // Test/maintenance hook: resolves when no engine work is in flight.
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.catch(() => undefined).finally(() => this.inflight.delete(p));
  }

  private recordResume(organizationId: string, workspaceId: string, runId: string, stepId: string, record: ResumeRecord): void {
    const s = this.store;
    s.assertWorkspaceActive(workspaceId, organizationId);
    const ws = s.workspaceDb(workspaceId, organizationId);
    ws.prepare(`CREATE TABLE IF NOT EXISTS engine_resumes(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, ok INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT`).run();
    const prior = ws.prepare("SELECT output_json, ok FROM engine_resumes WHERE run_id=? AND step_id=?").get(runId, stepId) as { output_json: string; ok: number } | undefined;
    if (prior) {
      if (prior.output_json !== JSON.stringify(record.output) || (prior.ok === 1) !== record.ok) {
        throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "workflow completion is immutable");
      }
      return;
    }
    ws.prepare("INSERT INTO engine_resumes(run_id, step_id, output_json, ok, created_at_ms) VALUES (?,?,?,?,?)")
      .run(runId, stepId, JSON.stringify(record.output), record.ok ? 1 : 0, s.now());
  }

  private readResume(workspaceId: string, organizationId: string, runId: string, stepId: string): ResumeRecord | undefined {
    const ws = this.store.workspaceDb(workspaceId, organizationId);
    ws.prepare(`CREATE TABLE IF NOT EXISTS engine_resumes(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, ok INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT`).run();
    const row = ws.prepare("SELECT output_json, ok FROM engine_resumes WHERE run_id=? AND step_id=?").get(runId, stepId) as { output_json: string; ok: number } | undefined;
    return row ? { output: JSON.parse(row.output_json) as JsonValue, ok: row.ok === 1 } : undefined;
  }

  private loadRun(workspaceId: string, organizationId: string, runId: string): { workflow: Workflow; input: JsonValue; actorId: string; configDigest: string; workflowDigest: string; state: string } {
    const ws = this.store.workspaceDb(workspaceId, organizationId);
    const run = ws.prepare("SELECT config_digest, workflow_digest, state FROM workflow_runs WHERE id=?").get(runId) as { config_digest: string; workflow_digest: string; state: string } | undefined;
    if (!run) throw new BrainDomainError("NOT_FOUND", "workflow run not found");
    const meta = ws.prepare("SELECT input_json, workflow_json, actor_id FROM run_inputs WHERE run_id=?").get(runId) as
      | { input_json: string; workflow_json: string; actor_id: string } | undefined;
    if (!meta) throw new BrainDomainError("NOT_FOUND", "workflow run input not found");
    return { workflow: JSON.parse(meta.workflow_json) as Workflow, input: JSON.parse(meta.input_json) as JsonValue, actorId: meta.actor_id, configDigest: run.config_digest, workflowDigest: run.workflow_digest, state: run.state };
  }

  private readOutputs(workspaceId: string, organizationId: string, runId: string): Record<string, JsonValue> {
    const ws = this.store.workspaceDb(workspaceId, organizationId);
    ws.prepare("CREATE TABLE IF NOT EXISTS step_outputs(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT").run();
    const outputs: Record<string, JsonValue> = {};
    for (const r of ws.prepare("SELECT step_id, output_json FROM step_outputs WHERE run_id=?").all(runId) as Array<{ step_id: string; output_json: string }>) {
      outputs[r.step_id] = JSON.parse(r.output_json) as JsonValue;
    }
    return outputs;
  }

  private applyResume(workspaceId: string, organizationId: string, runId: string, stepId: string, record: ResumeRecord): JsonValue {
    const s = this.store;
    const ws = s.workspaceDb(workspaceId, organizationId);
    ws.prepare("CREATE TABLE IF NOT EXISTS step_outputs(run_id TEXT NOT NULL, step_id TEXT NOT NULL, output_json TEXT NOT NULL, PRIMARY KEY(run_id, step_id)) STRICT").run();
    const digest = domainDigest("brain:step-output:v1", record.output);
    s.inTx(ws, () => {
      const prior = ws.prepare("SELECT state, output_digest FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string; output_digest: string | null } | undefined;
      if (!prior) throw new BrainDomainError("NOT_FOUND", "workflow step not found");
      if (prior.output_digest) {
        if (prior.output_digest !== digest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "workflow completion is immutable");
        return;
      }
      ws.prepare("INSERT OR REPLACE INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(runId, stepId, JSON.stringify(record.output));
      ws.prepare("UPDATE workflow_steps SET state=?, output_digest=? WHERE run_id=? AND step_id=?").run(record.ok ? "succeeded" : "failed", digest, runId, stepId);
    });
    if (!record.ok) throw new BrainDomainError("CONFLICT", `step ${stepId} completed with failure`);
    return record.output;
  }

  private async drive(organizationId: string, workspaceId: string, runId: string, mode: "start" | "resume", stepId?: string): Promise<void> {
    try {
      const { state } = this.loadRun(workspaceId, organizationId, runId);
      if (["succeeded", "failed", "cancelled", "partial"].includes(state)) {
        // Synchronous admission may already have terminalized the run; still
        // fire parent-link resumption for subgraph children.
        await this.finalize(organizationId, workspaceId, runId, state === "succeeded" || state === "partial" ? "success" : "failed");
        return;
      }
      const run = await this.ensureRun(organizationId, workspaceId, runId);
      const outcome = mode === "start"
        ? await run.start({ inputData: { __brainRun: runId, __organizationId: organizationId, __workspaceId: workspaceId } })
        : await run.resume({ step: stepId!, resumeData: this.readResume(workspaceId, organizationId, runId, stepId!) ?? { output: null, ok: false } });
      await this.finalize(organizationId, workspaceId, runId, outcome.status);
    } catch (e) {
      // Resume-before-suspend is durable via engine_resumes; the step will
      // consume it when reached. Other failures block the run for diagnosis.
      if (mode === "resume") {
        const { state } = this.loadRun(workspaceId, organizationId, runId);
        if (!["succeeded", "failed", "cancelled", "partial"].includes(state)) return;
      }
      const ws = this.store.workspaceDb(workspaceId, organizationId);
      ws.prepare("UPDATE workflow_runs SET state='blocked', version=version+1 WHERE id=? AND state NOT IN ('succeeded','failed','cancelled','partial')").run(runId);
      if (process.env["BRAIN_DEBUG_ENGINE"]) console.error(`[mastra-engine] drive ${mode} ${runId} failed`, e);
    }
  }

  private async finalize(organizationId: string, workspaceId: string, runId: string, mastraStatus: string): Promise<void> {
    const ws = this.store.workspaceDb(workspaceId, organizationId);
    const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string } | undefined;
    if (!run) return;
    if (mastraStatus === "suspended") return; // waiting on a Brain job/approval
    if (!["succeeded", "failed", "cancelled", "partial"].includes(run.state)) {
      if (mastraStatus === "success") {
        const steps = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ state: string }>;
        const anySkipped = steps.some((r) => r.state === "skipped");
        ws.prepare("UPDATE workflow_runs SET state=?, version=version+1 WHERE id=?").run(anySkipped ? "partial" : "succeeded", runId);
      } else {
        ws.prepare("UPDATE workflow_runs SET state='failed', version=version+1 WHERE id=?").run(runId);
      }
    }
    // Resume a parent subgraph step waiting on this child run.
    ws.prepare(`CREATE TABLE IF NOT EXISTS engine_links(child_run_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, parent_step_id TEXT NOT NULL, parent_workspace_id TEXT NOT NULL) STRICT`).run();
    const link = ws.prepare("SELECT parent_run_id, parent_step_id, parent_workspace_id FROM engine_links WHERE child_run_id=?").get(runId) as
      | { parent_run_id: string; parent_step_id: string; parent_workspace_id: string } | undefined;
    if (link) {
      const child = this.loadRun(workspaceId, organizationId, runId);
      const outputs = this.readOutputs(workspaceId, organizationId, runId);
      let output: JsonValue = outputs;
      try { output = resolveBinding(child.workflow.spec.outputs as unknown as Record<string, unknown>, child.input, outputs) as unknown as JsonValue; } catch { /* fall back to raw outputs */ }
      this.completeStep(organizationId, link.parent_workspace_id, link.parent_run_id, link.parent_step_id, output, mastraStatus === "success");
    }
  }

  private ensureMastra(): Promise<SharedMastra> {
    if (!this.sharedMastra) {
      this.sharedMastra = (async (): Promise<SharedMastra> => {
        const { createWorkflow, createStep } = (await import("@mastra/core/workflows")) as typeof import("@mastra/core/workflows");
        const { Mastra } = (await import("@mastra/core")) as typeof import("@mastra/core");
        const { LibSQLStore } = (await import("@mastra/libsql")) as unknown as { LibSQLStore: new (opts: { id: string; url: string }) => unknown };
        const mastra = new Mastra({
          storage: new LibSQLStore({ id: "brain-governor", url: `file:${join(this.storageDir, "mastra.db")}` }) as never,
        } as never) as unknown as SharedMastra["mastra"];
        return { mastra, createWorkflow, createStep };
      })();
    }
    return this.sharedMastra;
  }

  private ensureWorkflow(workflow: Workflow, workflowDigest: string): Promise<{ createRun: (opts?: { runId?: string }) => Promise<MastraRun> }> {
    const existing = this.loweredWorkflows.get(workflowDigest);
    if (existing) return existing as Promise<{ createRun: (opts?: { runId?: string }) => Promise<MastraRun> }>;
    const built = (async (): Promise<{ createRun: (opts?: { runId?: string }) => Promise<MastraRun> }> => {
      const shared = await this.ensureMastra();
      const mastraWorkflowId = `${workflow.metadata.id}-${workflowDigest.slice(7, 19)}`;
      const lowered = this.buildWorkflow(shared.createWorkflow, shared.createStep, workflow, mastraWorkflowId);
      shared.mastra.addWorkflow(lowered, mastraWorkflowId);
      const wf = shared.mastra.getWorkflow(mastraWorkflowId);
      // A Mastra Workflow is thenable (builder.then), so never return it
      // directly from an async function: Promise adoption would wait on its
      // step-composition method forever. Wrap it in a plain run factory.
      return { createRun: (opts) => wf.createRun(opts) };
    })();
    this.loweredWorkflows.set(workflowDigest, built as Promise<unknown>);
    return built;
  }

  private ensureRun(organizationId: string, workspaceId: string, runId: string): Promise<MastraRun> {
    this.runScopes.set(runId, { organizationId, workspaceId });
    const cached = this.runs.get(runId);
    if (cached) return cached;
    const built = (async (): Promise<MastraRun> => {
      const { workflow, workflowDigest } = this.loadRun(workspaceId, organizationId, runId);
      const wf = (await this.ensureWorkflow(workflow, workflowDigest)) as {
        createRun: (opts?: { runId?: string }) => Promise<MastraRun>;
      };
      return wf.createRun({ runId });
    })();
    this.runs.set(runId, built);
    return built;
  }

  private buildWorkflow(
    createWorkflow: typeof import("@mastra/core/workflows").createWorkflow,
    createStep: typeof import("@mastra/core/workflows").createStep,
    workflow: Workflow,
    mastraWorkflowId: string,
  ): unknown {
    const s = this.store;
    const order = compileWorkflowGraph(workflow, workflow.metadata.id);
    const loose = () => z.unknown();
    let builder: unknown = createWorkflow({ id: mastraWorkflowId, inputSchema: loose(), outputSchema: loose() } as never);
    for (const stepId of order) {
      const job = workflow.spec.jobs[stepId];
      if (!job) throw new BrainDomainError("INVALID_CONTRACT", `missing job ${stepId}`);
      const suspendable = job.kind !== "steer";
      const step = createStep({
        id: stepId,
        inputSchema: loose(),
        outputSchema: loose(),
        ...(suspendable ? { suspendSchema: z.object({ stepId: z.string() }), resumeSchema: z.looseObject({}) } : {}),
        execute: async ({ resumeData, suspend, runId: executionRunId, getInitData }: {
          resumeData?: ResumeRecord;
          suspend: (data: { stepId: string }) => Promise<never>;
          runId: string;
          getInitData: <T>() => T;
        }) => {
          const runId = executionRunId;
          const init = (() => {
            try { return getInitData<Record<string, unknown>>(); } catch { return undefined; }
          })();
          const scope = this.runScopes.get(runId) ?? (init?.__organizationId && init?.__workspaceId
            ? { organizationId: String(init.__organizationId), workspaceId: String(init.__workspaceId) }
            : undefined);
          if (!scope) throw new BrainDomainError("NOT_FOUND", "workflow run scope not found");
          const { organizationId, workspaceId } = scope;
          this.runScopes.set(runId, scope);
          const ws = s.workspaceDb(workspaceId, organizationId);
          const runRow = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string } | undefined;
          if (runRow?.state === "cancelled") throw new BrainDomainError("CONFLICT", "run cancelled");
          const { input, actorId, configDigest } = this.loadRun(workspaceId, organizationId, runId);
          const outputs = this.readOutputs(workspaceId, organizationId, runId);
          // Admission may have skipped this step (a need failed/was skipped)
          // before the Mastra chain reached it: pass through without effects.
          const admitted = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string } | undefined;
          if (admitted?.state === "skipped") return {} as Record<string, JsonValue>;
          const bound = resolveBinding(job.input as unknown as Record<string, unknown>, input, outputs);
          if (job.kind === "steer") {
            if (outputs[stepId] === undefined) {
              this.host.recordSteer({ organizationId, workspaceId, runId, stepId, payload: bound as unknown as JsonValue });
            }
            return this.applyResume(workspaceId, organizationId, runId, stepId, { output: { steered: true }, ok: true }) as Record<string, JsonValue>;
          }
          const resumed = resumeData ?? this.readResume(workspaceId, organizationId, runId, stepId);
          if (resumed) {
            return this.applyResume(workspaceId, organizationId, runId, stepId, resumed) as Record<string, JsonValue>;
          }
          if (job.kind === "gate") {
            const subject = (bound["subject"] ?? bound) as JsonValue;
            const stepRow = ws.prepare("SELECT state, job_id FROM workflow_steps WHERE run_id=? AND step_id=?").get(runId, stepId) as { state: string; job_id: string | null };
            if (stepRow.state !== "waiting") {
              const approvalId = this.host.createApprovalForGate({
                organizationId, workspaceId, runId, stepId, subject,
                expiresAtMs: s.now() + ((job as { expiresAfterSeconds?: number }).expiresAfterSeconds ?? 3600) * 1000, requestedBy: actorId,
              });
              ws.prepare("UPDATE workflow_steps SET state='waiting', job_id=? WHERE run_id=? AND step_id=?").run(approvalId, runId, stepId);
              ws.prepare("UPDATE workflow_runs SET state='suspended', wait_generation=wait_generation+1, version=version+1 WHERE id=?").run(runId);
            }
            return suspend({ stepId });
          }
          if (job.kind === "subgraph") {
            const ref = (job as { workflow?: { id?: string } }).workflow?.id;
            if (!ref) throw new BrainDomainError("INVALID_CONTRACT", `subgraph ${stepId} missing workflow ref`);
            const child = this.host.loadWorkflow(organizationId, ref);
            const { runId: childRunId } = this.startRun({
              organizationId, workspaceId, actorId, workflowId: ref, workflow: child.workflow,
              configDigest: child.configDigest, runInput: bound as unknown as JsonValue, executionKey: `${runId}:${stepId}:child`,
            });
            ws.prepare(`CREATE TABLE IF NOT EXISTS engine_links(child_run_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, parent_step_id TEXT NOT NULL, parent_workspace_id TEXT NOT NULL) STRICT`).run();
            ws.prepare("INSERT OR REPLACE INTO engine_links(child_run_id, parent_run_id, parent_step_id, parent_workspace_id) VALUES (?,?,?,?)").run(childRunId, runId, stepId, workspaceId);
            ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(childRunId, runId, stepId);
            return suspend({ stepId });
          }
          if (job.kind === "eval") {
            // Evaluator jobs are admitted by evidenceSubmitted; the step only waits.
            return suspend({ stepId });
          }
          const placement = "runsOn" in job ? (job as { runsOn: unknown }).runsOn : undefined;
          const effectClass = job.kind === "dispatch" && "effectClass" in job ? String((job as { effectClass: string }).effectClass) : "read";
          const executionDigest = domainDigest("brain:step-exec:v1", { stepId, bound } as unknown as JsonValue);
          const jobId = this.host.createJobForStep({
            organizationId, workspaceId, runId, stepId,
            executionKey: `${runId}:${stepId}`, configDigest,
            placementJson: JSON.stringify(placement ?? {}),
            executionDigest, effectClass, kind: job.kind,
            payload: { step: job as unknown as JsonValue, input: bound as unknown as JsonValue },
          });
          ws.prepare("UPDATE workflow_steps SET state='running', job_id=? WHERE run_id=? AND step_id=?").run(jobId, runId, stepId);
          return suspend({ stepId });
        },
      } as never);
      builder = (builder as { then: (s2: unknown) => unknown }).then(step);
    }
    return (builder as { commit: () => unknown }).commit();
  }
}
