import type { CheckResult, EvidenceBundle, Workflow } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";

// Governor-side attestation fixture. Never use a runner's hello claims as proof
// of a host/trust boundary; production provisioning must supply a real verifier.
export function attestDomain(brain: Brain, runnerId: string, domain: string): void {
  brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES (?,?,1,'governor-test-attestation',?,?)").run(runnerId,`trust:domain:${domain}`,brain.store.now(),brain.store.now()+3600_000);
}

export function bundleForAttempt(brain: Brain, organizationId: string, workspaceId: string, attemptId: string, bundleId: string): EvidenceBundle {
  const author = brain.store.control.prepare("SELECT a.job_id,a.job_fence,j.workflow_run_id,j.config_digest,p.payload_json,r.source_revision FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN job_payloads p ON p.job_id=j.id JOIN config_releases r ON r.digest=j.config_digest WHERE a.id=?").get(attemptId) as { job_id:string;job_fence:number;workflow_run_id:string;config_digest:string;payload_json:string;source_revision:string };
  const ws = brain.store.workspaceDb(workspaceId,organizationId);
  const run = ws.prepare("SELECT workflow_digest FROM workflow_runs WHERE id=?").get(author.workflow_run_id) as { workflow_digest:string };
  const meta = ws.prepare("SELECT workflow_json FROM run_inputs WHERE run_id=?").get(author.workflow_run_id) as { workflow_json:string };
  const workflow = JSON.parse(meta.workflow_json) as Workflow;
  const evaluator = Object.values(workflow.spec.jobs).find((j) => j.kind === "eval");
  if (evaluator?.kind !== "eval") throw new Error("fixture needs a pinned evaluator");
  const release = JSON.parse((brain.store.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(author.config_digest) as { manifest_json:string }).manifest_json) as { evaluators: Record<string,{spec:{requiredChecks:string[]}}> };
  const checks: CheckResult[] = release.evaluators[evaluator.evaluator.id]!.spec.requiredChecks.map((checkId) => ({ criterionId:checkId,checkId,status:"passed",oracleDigest:evaluator.evaluator.digest,artifacts:[],detail:"Author claims this criterion; independent evaluator required" }));
  const payload = JSON.parse(author.payload_json) as { step:{ uses?:{release:{id:string;digest:string}} } };
  return { contractVersion:"brain.evidence/v1",bundleId,organizationId,workspaceId,workflowRunId:author.workflow_run_id,jobId:author.job_id,attemptId,jobFence:author.job_fence,
    sourceRevision:author.source_revision,configDigest:author.config_digest,workflowDigest:run.workflow_digest,primitiveVersions:{},toolReleases:payload.step.uses ? [payload.step.uses.release] : [],artifacts:[],checks,approvalIds:[],effects:[],createdAt:brain.store.nowIso() };
}
