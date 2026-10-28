import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, CheckResult, EvaluationAssignment, Evaluator, EvidenceBundle, JsonValue, VerificationVerdict, Workflow } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";

export interface EvidenceRunner { runnerId: string; epoch: number; organizationId: string }
interface Attempt {
  id: string; job_id: string; runner_id: string; runner_epoch: number; state: string;
  job_fence: number; current_fence: number; lease_expires_at_ms: number; receipt_digest: string | null; cleanup_confirmed: number;
  organization_id: string; workspace_id: string; workflow_run_id: string; step_id: string; config_digest: string;
  job_state: string; session_epoch: number; admin_state: string; group_id: string;
  effect_class: string;
}
interface PinnedRelease {
  source_revision: string;
  manifest_json: string;
}
export interface EvidenceHost {
  completeStep(organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean): void;
}

export function pinnedEvaluator(s: Store, organizationId: string, configDigest: string, ref: { id: string; digest: string }): Evaluator {
  const row = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(configDigest, organizationId) as { manifest_json: string } | undefined;
  const release = row ? JSON.parse(row.manifest_json) as { evaluators?: Record<string, Evaluator>; manifest: { documents: Array<{ kind: string; id: string; digest: string }> } } : undefined;
  const evaluator = release?.evaluators?.[ref.id];
  const entry = release?.manifest.documents.find((d) => d.kind === "Evaluator" && d.id === ref.id && d.digest === ref.digest);
  if (!evaluator || !entry) throw new BrainDomainError("POLICY_DENIED", "evaluator is not pinned in the run's configuration release");
  return evaluator;
}

function same(a: unknown, b: unknown): boolean {
  return domainDigest("brain:evidence-value:v1", a as JsonValue) === domainDigest("brain:evidence-value:v1", b as JsonValue);
}

export class EvidenceService {
  constructor(private readonly s: Store, private readonly host: EvidenceHost) {}

  private attempt(id: string): Attempt {
    const row = this.s.control.prepare(`SELECT a.*,j.organization_id,j.workspace_id,j.workflow_run_id,j.step_id,j.config_digest,
      j.state AS job_state,j.effect_class,j.job_fence AS current_fence,r.session_epoch,r.admin_state,r.group_id
      FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN runners r ON r.id=a.runner_id AND r.organization_id=j.organization_id WHERE a.id=?`).get(id) as Attempt | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "evidence attempt not found");
    return row;
  }

  private currentRunner(runner: EvidenceRunner, row: Attempt): void {
    if (row.organization_id !== runner.organizationId || row.runner_id !== runner.runnerId) throw new BrainDomainError("FORBIDDEN", "evidence attempt belongs to another runner");
    if (row.runner_epoch !== runner.epoch || row.session_epoch !== runner.epoch || ["quarantined", "disabled"].includes(row.admin_state) || row.job_fence !== row.current_fence) throw new BrainDomainError("LEASE_LOST", "evidence attempt is fenced");
    this.s.assertWorkspaceActive(row.workspace_id, row.organization_id);
  }

  private verifyArtifacts(bundle: EvidenceBundle): void {
    const total=bundle.artifacts.reduce((bytes,ref)=>bytes+ref.bytes,0);
    if (!Number.isSafeInteger(total) || total>100*1024*1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "bundle artifact verification exceeds the 100 MiB admission limit");
    const refs = new Map(bundle.artifacts.map((a) => [a.artifactId, a]));
    if (refs.size !== bundle.artifacts.length) throw new BrainDomainError("INVALID_CONTRACT", "duplicate artifact identity");
    for (const check of bundle.checks) for (const ref of check.artifacts) {
      if (!refs.has(ref.artifactId) || !same(ref, refs.get(ref.artifactId))) throw new BrainDomainError("EVIDENCE_MISSING", "check artifact is not in the immutable bundle");
    }
    const ws = this.s.workspaceDb(bundle.workspaceId, bundle.organizationId);
    for (const ref of refs.values()) {
      const association = this.s.control.prepare("SELECT 1 FROM artifact_associations WHERE artifact_id=? AND organization_id=? AND workspace_id=? AND digest=?").get(ref.artifactId, bundle.organizationId, bundle.workspaceId, ref.digest);
      const stored = ws.prepare("SELECT digest,bytes,media_type,classification,state FROM artifacts WHERE id=?").get(ref.artifactId) as { digest: string; bytes: number; media_type: string; classification: string; state: string } | undefined;
      if (!association || !stored || stored.state !== "verified" || stored.digest !== ref.digest || stored.bytes !== ref.bytes || stored.media_type !== ref.mediaType || stored.classification !== ref.classification) throw new BrainDomainError("EVIDENCE_MISSING", "artifact scope or metadata does not match durable storage");
      this.verifyBytes(ref);
    }
  }

  private verifyBytes(ref: ArtifactRef): void {
    const hex = ref.digest.slice(7);
    let fd: number | undefined;
    try {
      fd = openSync(join(this.s.dataDir, "cas", hex.slice(0, 2), hex), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== ref.bytes || stat.size > 100 * 1024 * 1024) throw new Error("size");
      const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let count = 0;
      for (;;) { const read = readSync(fd, buffer); if (!read) break; count += read; if (count > ref.bytes) throw new Error("changed"); hash.update(buffer.subarray(0, read)); }
      if (count !== ref.bytes || `sha256:${hash.digest("hex")}` !== ref.digest) throw new Error("digest");
    } catch { throw new BrainDomainError("EVIDENCE_MISSING", "artifact bytes are missing or changed"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private bundle(workspaceId: string, organizationId: string, digest: string): EvidenceBundle {
    const ws = this.s.workspaceDb(workspaceId, organizationId);
    const row = ws.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=?").get(digest) as { manifest_json: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "evidence bundle not found");
    const bundle = JSON.parse(row.manifest_json) as EvidenceBundle;
    if (!validate("EvidenceBundle", bundle).ok || bundle.organizationId !== organizationId || bundle.workspaceId !== workspaceId || domainDigest("brain:evidence-bundle:v1", bundle as unknown as JsonValue) !== digest) throw new BrainDomainError("EVIDENCE_MISSING", "stored bundle manifest does not match its immutable digest");
    return bundle;
  }

  submit(runner: EvidenceRunner, raw: unknown): { digest: string } {
    const check = validate("EvidenceBundle", raw);
    if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
    const bundle = raw as EvidenceBundle; const author = this.attempt(bundle.attemptId);
    this.currentRunner(runner, author);
    if (author.job_id !== bundle.jobId || author.workspace_id !== bundle.workspaceId || author.workflow_run_id !== bundle.workflowRunId || author.organization_id !== bundle.organizationId || author.job_fence !== bundle.jobFence || author.config_digest !== bundle.configDigest) throw new BrainDomainError("FORBIDDEN", "bundle does not match its authenticated author attempt");
    if (author.state !== "verifying" || author.job_state !== "verifying" || !author.receipt_digest || author.cleanup_confirmed !== 1) throw new BrainDomainError("EVIDENCE_MISSING", "author receipt and confirmed cleanup must precede evidence");
    const ws = this.s.workspaceDb(bundle.workspaceId, bundle.organizationId);
    const run = ws.prepare("SELECT workflow_digest,state FROM workflow_runs WHERE id=?").get(bundle.workflowRunId) as { workflow_digest: string; state: string } | undefined;
    const release = this.s.control.prepare("SELECT source_revision,manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(bundle.configDigest, bundle.organizationId) as PinnedRelease | undefined;
    if (!run || !release || run.workflow_digest !== bundle.workflowDigest || release.source_revision !== bundle.sourceRevision || ["cancelled", "failed", "succeeded"].includes(run.state)) throw new BrainDomainError("EVIDENCE_MISSING", "bundle run, workflow or source revision is not current");
    if (new Set(bundle.checks.map((c) => `${c.criterionId}\n${c.checkId}`)).size !== bundle.checks.length) throw new BrainDomainError("INVALID_CONTRACT", "duplicate evidence check");
    const payload=this.s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(author.job_id) as {payload_json:string};
    const step=(JSON.parse(payload.payload_json) as {step:{uses?:{release:{id:string;digest:string}}}}).step;
    if (step.uses && !same(bundle.toolReleases,[step.uses.release])) throw new BrainDomainError("FORBIDDEN", "bundle tool release does not match the admitted execution");
    for (const effect of bundle.effects) {
      const permit=this.s.control.prepare("SELECT 1 FROM effect_permits WHERE attempt_id=? AND invocation_id=?").get(author.id,effect.invocationId);
      const receipt=this.s.control.prepare("SELECT 1 FROM domain_operation_receipts WHERE invocation_id=? AND target_key=? AND operation=? AND outcome=? AND receipt_digest=?").get(effect.invocationId,effect.targetId,effect.operation,effect.outcome,effect.receiptArtifact.digest);
      if (author.effect_class === "read" || !permit || !receipt || !bundle.artifacts.some((a)=>same(a,effect.receiptArtifact))) throw new BrainDomainError("EVIDENCE_MISSING", "external effect is not backed by an authorized reconciled receipt");
    }
    for (const approvalId of bundle.approvalIds) if (!this.s.control.prepare("SELECT 1 FROM approval_consumptions WHERE approval_id=? AND attempt_id=?").get(approvalId, bundle.attemptId)) throw new BrainDomainError("FORBIDDEN", "bundle approval is not bound to the author attempt");
    this.verifyArtifacts(bundle);
    const digest = domainDigest("brain:evidence-bundle:v1", bundle as unknown as JsonValue);
    this.s.inTx(ws, () => {
      const existing = ws.prepare("SELECT digest FROM evidence_bundles WHERE bundle_id=?").get(bundle.bundleId) as { digest: string } | undefined;
      if (existing && existing.digest !== digest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "bundle identity is immutable; submit a new identity");
      ws.prepare("INSERT OR IGNORE INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?,'submitted',?,?)").run(digest,bundle.bundleId,bundle.jobId,bundle.attemptId,JSON.stringify(bundle),this.s.now());
    });
    return { digest };
  }

  assignment(jobId: string): EvaluationAssignment | null {
    const row = this.s.control.prepare("SELECT kind,payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { kind: string; payload_json: string } | undefined;
    if (row?.kind !== "eval") return null;
    const assignment = (JSON.parse(row.payload_json) as { evaluation?: unknown }).evaluation;
    if (!validate("EvaluationAssignment", assignment).ok) return null;
    return assignment as EvaluationAssignment;
  }

  evaluatorEligible(runnerId: string, jobId: string): boolean {
    const row = this.s.control.prepare("SELECT kind FROM job_payloads WHERE job_id=?").get(jobId) as { kind: string } | undefined;
    if (row?.kind !== "eval") return true;
    const assignment = this.assignment(jobId);
    if (!assignment || assignment.independence === "L3") return false;
    const job = this.s.control.prepare("SELECT organization_id,workspace_id FROM jobs WHERE id=?").get(jobId) as { organization_id: string; workspace_id: string };
    for (const digest of assignment.bundleDigests) {
      const bundle = this.bundle(job.workspace_id, job.organization_id, digest);
      const author = this.attempt(bundle.attemptId);
      if (assignment.independence === "L2" && (author.runner_id === runnerId || !this.separateDomains(author.runner_id, runnerId))) return false;
    }
    return true;
  }

  private separateDomains(authorId: string, evaluatorId: string): boolean {
    const domains = (id: string) => this.s.control.prepare("SELECT capability FROM runner_capabilities WHERE runner_id=? AND verified=1 AND capability LIKE 'trust:domain:%' AND expires_at_ms>?").all(id,this.s.now()) as Array<{ capability: string }>;
    const author = domains(authorId); const evaluator = domains(evaluatorId);
    // Distinct runner IDs/groups alone do not prove separate hosts or trust domains.
    return author.length === 1 && evaluator.length === 1 && author[0]!.capability !== evaluator[0]!.capability;
  }

  accept(runner: EvidenceRunner, workspaceId: string, raw: unknown): { verdictId: string; outcome: VerificationVerdict["outcome"] } {
    const valid = validate("VerificationVerdict", raw);
    if (!valid.ok) throw new BrainDomainError("INVALID_CONTRACT", valid.errors.join("; "));
    const verdict = raw as VerificationVerdict; const bundle = this.bundle(workspaceId,runner.organizationId,verdict.bundleDigest);
    const evaluator = this.attempt(verdict.evaluatorAttemptId);
    this.currentRunner(runner,evaluator);
    if (verdict.acceptedBy !== runner.runnerId || evaluator.workspace_id !== workspaceId || evaluator.workflow_run_id !== bundle.workflowRunId || evaluator.config_digest !== bundle.configDigest || evaluator.id === bundle.attemptId) throw new BrainDomainError("FORBIDDEN", "verdict is not from the independent assigned evaluator");
    const ws = this.s.workspaceDb(workspaceId,runner.organizationId);
    const prior = ws.prepare("SELECT id,manifest_json FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms LIMIT 1").get(verdict.bundleDigest) as { id: string; manifest_json: string } | undefined;
    if (prior) {
      if (!same(JSON.parse(prior.manifest_json),verdict)) throw new BrainDomainError("CONFLICT", "bundle already has an immutable verdict");
      this.finalize(runner.organizationId,workspaceId,prior.id);
      return { verdictId: prior.id, outcome: verdict.outcome };
    }
    const run=ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(bundle.workflowRunId) as {state:string} | undefined;
    if (!run || ["cancelled","failed","succeeded","partial"].includes(run.state)) throw new BrainDomainError("FORBIDDEN", "terminal workflow cannot accept a new verdict");
    const author = this.attempt(bundle.attemptId);
    const assignment = this.assignment(evaluator.job_id);
    if (!assignment || !assignment.bundleDigests.includes(verdict.bundleDigest) || !same(assignment.evaluatorRelease,verdict.evaluatorRelease) || assignment.independence !== verdict.independence || !this.evaluatorEligible(runner.runnerId,evaluator.job_id)) throw new BrainDomainError("FORBIDDEN", "evaluator was not admitted for these exact immutable inputs");
    const pinned = pinnedEvaluator(this.s,runner.organizationId,bundle.configDigest,verdict.evaluatorRelease);
    const runInput = ws.prepare("SELECT workflow_json FROM run_inputs WHERE run_id=?").get(bundle.workflowRunId) as { workflow_json: string };
    const step = (JSON.parse(runInput.workflow_json) as Workflow).spec.jobs[evaluator.step_id];
    if (step?.kind !== "eval" || evaluator.group_id !== step.runsOn.group || !same(step.evaluator,verdict.evaluatorRelease) || !same(pinned.spec.requiredChecks,assignment.requiredChecks) || (pinned.spec.independence === "L2" && assignment.independence === "L1") || pinned.spec.independence === "L3") throw new BrainDomainError("POLICY_DENIED", "evaluator release, group, primitive or independence policy changed");
    if (author.state !== "verifying" || author.job_state !== "verifying" || author.job_fence !== author.current_fence || evaluator.state !== "verifying" || evaluator.job_state !== "verifying" || evaluator.cleanup_confirmed !== 1 || !evaluator.receipt_digest || evaluator.lease_expires_at_ms <= this.s.now()) throw new BrainDomainError("LEASE_LOST", "author or evaluator is not current and ready for verification");
    const checks = new Map(verdict.checks.map((c) => [c.checkId,c]));
    if (checks.size !== verdict.checks.length || checks.size !== assignment.requiredChecks.length || assignment.requiredChecks.some((id) => !checks.has(id))) throw new BrainDomainError("EVIDENCE_MISSING", "verdict must report every pinned check exactly once");
    const authored = new Map(bundle.checks.map((c) => [c.checkId,c.criterionId]));
    for (const check of checks.values()) {
      if (check.oracleDigest !== verdict.evaluatorRelease.digest || assignment.criteria[check.checkId] !== check.criterionId || authored.get(check.checkId) !== check.criterionId || check.artifacts.some((a) => !bundle.artifacts.some((b) => same(a,b)))) throw new BrainDomainError("EVIDENCE_MISSING", "verdict criterion, oracle or immutable artifact does not match");
    }
    const output = this.s.control.prepare("SELECT output_json FROM job_outputs WHERE job_id=?").get(evaluator.job_id) as { output_json: string } | undefined;
    const reported = output ? JSON.parse(output.output_json) as { checks?: CheckResult[] } : undefined;
    if (!reported?.checks || !same(reported.checks,verdict.checks)) throw new BrainDomainError("EVIDENCE_MISSING", "verdict checks do not match the evaluator's committed execution receipt");
    const statuses = verdict.checks.map((c) => c.status);
    if ((verdict.outcome === "verified" && statuses.some((v) => v !== "passed")) || (verdict.outcome === "rejected" && !statuses.includes("failed")) || (verdict.outcome === "incomplete" && !statuses.some((v) => v === "missing" || v === "inconclusive"))) throw new BrainDomainError("EVIDENCE_MISSING", "verdict outcome contradicts its checks");
    if (verdict.outcome === "verified") {
      const guards=this.s.control.prepare("SELECT 1 FROM resource_leases WHERE attempt_id=? AND unresolved_effect=1 LIMIT 1").get(author.id);
      const permits=this.s.control.prepare("SELECT invocation_id,state FROM effect_permits WHERE attempt_id=?").all(author.id) as Array<{invocation_id:string;state:string}>;
      if (guards || (author.effect_class !== "read" && permits.length === 0) || permits.some((p)=>!["applied","absent"].includes(p.state) || !bundle.effects.some((e)=>e.invocationId===p.invocation_id && e.outcome===p.state))) throw new BrainDomainError("EVIDENCE_MISSING", "external effects require independent reconciliation before success");
    }
    this.verifyArtifacts(bundle);
    const verdictId = this.s.id("verdict");
    this.s.inTx(ws,() => {
      ws.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES (?,?,?,?,?,?,?)").run(verdictId,verdict.bundleDigest,evaluator.id,verdict.evaluatorRelease.digest,verdict.outcome,JSON.stringify(verdict),this.s.now());
      ws.prepare("UPDATE evidence_bundles SET state=? WHERE digest=?").run(verdict.outcome,verdict.bundleDigest);
    });
    // Workspace commit is the durable intent. A crash before/during either
    // projection is retried from finalized_at_ms=NULL, without cross-WAL atomicity.
    this.finalize(runner.organizationId,workspaceId,verdictId);
    return { verdictId, outcome: verdict.outcome };
  }

  finalize(organizationId: string, workspaceId: string, verdictId: string): void {
    this.s.assertWorkspaceActive(workspaceId,organizationId);
    const ws = this.s.workspaceDb(workspaceId,organizationId);
    const row = ws.prepare("SELECT manifest_json,finalized_at_ms FROM verification_verdicts WHERE id=?").get(verdictId) as { manifest_json: string; finalized_at_ms: number | null } | undefined;
    if (!row || row.finalized_at_ms !== null) return;
    const verdict = JSON.parse(row.manifest_json) as VerificationVerdict;
    const bundle = this.bundle(workspaceId,organizationId,verdict.bundleDigest);
    const run=ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(bundle.workflowRunId) as {state:string} | undefined;
    if (run?.state === "cancelled") {
      // Retain the accepted historical fact without resuming cancelled work.
      ws.prepare("UPDATE verification_verdicts SET finalized_at_ms=? WHERE id=?").run(this.s.now(),verdictId);
      return;
    }
    const author = this.attempt(bundle.attemptId); const evaluator = this.attempt(verdict.evaluatorAttemptId);
    const assignment = this.assignment(evaluator.job_id);
    if (!assignment) throw new BrainDomainError("EVIDENCE_MISSING", "accepted verdict lost its pinned assignment");
    const allVerdicts = assignment.bundleDigests.map((digest) => ws.prepare("SELECT outcome FROM verification_verdicts WHERE bundle_digest=? LIMIT 1").get(digest) as { outcome: string } | undefined);
    const evaluationComplete = allVerdicts.every((v) => v && v.outcome !== "incomplete");
    const digest = domainDigest("brain:verdict:v1",verdict as unknown as JsonValue);
    this.s.inTx(this.s.control,() => {
      const prior = this.s.control.prepare("SELECT payload_digest FROM inbox WHERE source_id='evidence' AND event_id=?").get(verdictId) as { payload_digest: string } | undefined;
      if (prior) { if (prior.payload_digest !== digest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "verdict projection collision"); return; }
      if (author.job_fence !== author.current_fence) throw new BrainDomainError("LEASE_LOST", "accepted verdict cannot finalize a newer attempt");
      if (verdict.outcome !== "incomplete") {
        const state = verdict.outcome === "verified" ? "succeeded" : "failed";
        this.s.control.prepare("UPDATE jobs SET state=?,version=version+1 WHERE id=? AND state='verifying' AND job_fence=?").run(state,author.job_id,bundle.jobFence);
        this.s.control.prepare("UPDATE job_attempts SET state=? WHERE id=? AND state='verifying'").run(state,author.id);
      }
      if (evaluationComplete) {
        this.s.control.prepare("UPDATE jobs SET state='succeeded',version=version+1 WHERE id=? AND state='verifying'").run(evaluator.job_id);
        this.s.control.prepare("UPDATE job_attempts SET state='succeeded' WHERE id=? AND state='verifying'").run(evaluator.id);
      }
      // A general verdict proves checks. Resource effect guards are released
      // only by connector readback/reconciliation, never by a runner assertion.
      this.s.control.prepare("INSERT INTO inbox(source_id,event_id,payload_digest,applied_at_ms) VALUES ('evidence',?,?,?)").run(verdictId,digest,this.s.now());
    });
    if (verdict.outcome !== "incomplete") {
      const authorOutput = this.s.control.prepare("SELECT output_json FROM job_outputs WHERE job_id=?").get(author.job_id) as { output_json: string };
      this.host.completeStep(organizationId,workspaceId,author.workflow_run_id,author.step_id,JSON.parse(authorOutput.output_json) as JsonValue,verdict.outcome === "verified");
    }
    if (evaluationComplete) {
      const output = this.s.control.prepare("SELECT output_json FROM job_outputs WHERE job_id=?").get(evaluator.job_id) as { output_json: string };
      this.host.completeStep(organizationId,workspaceId,evaluator.workflow_run_id,evaluator.step_id,JSON.parse(output.output_json) as JsonValue,allVerdicts.every((v) => v?.outcome === "verified"));
    }
    // Card acceptance requires an explicit card/criteria binding. Never attach
    // a verdict to all verifying cards in the workspace.
    ws.prepare("UPDATE verification_verdicts SET finalized_at_ms=? WHERE id=?").run(this.s.now(),verdictId);
  }
}
