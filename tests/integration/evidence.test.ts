import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArtifactRef, EvaluationAssignment, VerificationVerdict } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { normalizeEvaluation } from "../../apps/runner/src/tools/invoke";
import { setupWorld } from "../helpers";
import { attestDomain, bundleForAttempt } from "../support/evidence";

async function world(executeAuthor = false) {
  const app=await createApp({dataDir:mkdtempSync(join(tmpdir(),"brain-evidence-")),allowTestActor:true});
  const w=setupWorld(app.brain);
  const transport: typeof fetch = async(input,init) => app.fetch(new Request(input,init));
  const config=(runnerId:string):RunnerConfig=>({runnerId,governorUrl:"http://127.0.0.1:3000",stateDir:join(w.dir,runnerId),transport,
    capabilities:["os:linux","tool:bash","tool:python3","isolation:ephemeral-container","trust:domain:self-asserted"]});
  const authorConfig=config("author-runner");const evaluatorConfig=config("evaluator-runner");
  const authorSession=await enrollAndHello(authorConfig,w.brain.issueEnrollment(w.owner,"fixture-tools").token);
  const evaluatorSession=await enrollAndHello(evaluatorConfig,w.brain.issueEnrollment(w.owner,"fixture-evaluators").token);
  const author={runnerId:authorConfig.runnerId,epoch:authorSession.epoch,organizationId:w.org};
  const evaluator={runnerId:evaluatorConfig.runnerId,epoch:evaluatorSession.epoch,organizationId:w.org};
  const digest=w.brain.activeRelease(w.org)!.digest;
  w.brain.executeCommand(w.owner,{contractVersion:"brain.command/v1",commandId:"dispatch-evidence",commandType:"workflow.dispatch",workspaceId:w.workspaceId,idempotencyKey:"dispatch-evidence",
    payload:{workflow:{id:"fixture-workflow",digest},input:{message:"Brain fixture"}}},"corr-evidence");
  if (executeAuthor) {
    await runOnce(authorConfig,authorSession.sessionToken,authorSession.epoch);
  } else {
    // Arrange a receipted author without submitting a bundle. Negative evidence
    // cases must begin before submission/admission; real supervisor submission
    // is covered separately below and by agent-dispatch.test.ts.
    const offer=w.brain.claim(author,"author-claim") as unknown as {attemptId:string;leaseId:string;jobFence:number};
    w.brain.ackAttempt(author,offer.attemptId,{leaseId:offer.leaseId,jobFence:offer.jobFence});
    w.brain.completeAttempt(author,offer.attemptId,{result:"succeeded",output:{message:"Brain fixture",bytes:13},jobFence:offer.jobFence,cleanupConfirmed:true});
  }
  const attempt=w.brain.store.control.prepare("SELECT a.id FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.step_id='echo'").get() as {id:string};
  const bundle=executeAuthor
    ? JSON.parse((w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT manifest_json FROM evidence_bundles WHERE attempt_id=?").get(attempt.id) as {manifest_json:string}).manifest_json) as import("@brain/contracts").EvidenceBundle
    : bundleForAttempt(w.brain,w.org,w.workspaceId,attempt.id,"bundle-author");
  return {...w,app,authorConfig,evaluatorConfig,authorSession,evaluatorSession,author,evaluator,bundle};
}

type World=Awaited<ReturnType<typeof world>>;
function addArtifact(w:World):ArtifactRef {
  const bytes=Buffer.from("durable evaluator input");
  const upload=w.brain.initUpload(w.owner,{workspaceId:w.workspaceId,attemptId:w.bundle.attemptId,expectedDigest:sha256Digest(bytes),expectedBytes:bytes.length}) as {uploadId:string};
  const artifact=w.brain.putUpload(w.owner,upload.uploadId,bytes) as unknown as ArtifactRef;
  w.bundle={...w.bundle,artifacts:[artifact],checks:w.bundle.checks.map(c=>({...c,artifacts:[artifact]}))};
  return artifact;
}

async function admitted(prepare?: (w:World)=>void) {
  const w=await world();
  prepare?.(w);
  const submitted=w.brain.submitEvidence(w.author,w.bundle) as {digest:string};
  attestDomain(w.brain,w.author.runnerId,"author-host");attestDomain(w.brain,w.evaluator.runnerId,"evaluator-host");
  const offer=w.brain.claim(w.evaluator,"claim-eval") as unknown as {attemptId:string;jobId:string;leaseId:string;jobFence:number};
  expect(offer).toBeTruthy();
  w.brain.ackAttempt(w.evaluator,offer.attemptId,{leaseId:offer.leaseId,jobFence:offer.jobFence});
  const offerPayload=JSON.parse(new TextDecoder().decode(w.brain.readExecutionArtifact(w.evaluator,offer.attemptId))) as {evaluation:EvaluationAssignment};
  const output=normalizeEvaluation({passed:true,checks:[{id:"echo-message",passed:true},{id:"echo-bytes",passed:true}]},offerPayload.evaluation);
  w.brain.completeAttempt(w.evaluator,offer.attemptId,{result:"succeeded",output,jobFence:offer.jobFence,cleanupConfirmed:true});
  const verdict:VerificationVerdict={contractVersion:"brain.verdict/v1",bundleDigest:submitted.digest,evaluatorAttemptId:offer.attemptId,evaluatorRelease:offerPayload.evaluation.evaluatorRelease,
    independence:offerPayload.evaluation.independence,outcome:"verified",checks:(output as unknown as {checks:VerificationVerdict["checks"]}).checks,acceptedBy:w.evaluator.runnerId,createdAt:w.brain.store.nowIso()};
  return {...w,offer,verdict};
}

describe("authenticated immutable evidence and real evaluator admission",()=>{
  it("runs the pinned tool and admitted evaluator through real HTTP handlers without synthetic verdicts",async()=>{
    const w=await world(true);
    try {
      const ws=w.brain.store.workspaceDb(w.workspaceId,w.org);
      ws.prepare("INSERT INTO cards(id,title,state,criteria_json,created_at_ms) VALUES ('unrelated','Unrelated','verifying','[\"other\"]',?)").run(w.brain.store.now());
      w.brain.submitEvidence(w.author,w.bundle);
      expect(await runOnce(w.evaluatorConfig,w.evaluatorSession.sessionToken)).toBe(false); // hello is not trust attestation
      attestDomain(w.brain,w.author.runnerId,"author-host");attestDomain(w.brain,w.evaluator.runnerId,"evaluator-host");
      expect(await runOnce(w.evaluatorConfig,w.evaluatorSession.sessionToken)).toBe(true);
      expect((ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(w.bundle.workflowRunId) as {state:string}).state).toBe("succeeded");
      expect(w.brain.store.control.prepare("SELECT state FROM jobs ORDER BY step_id").all()).toEqual([{state:"succeeded"},{state:"succeeded"}]);
      expect(ws.prepare("SELECT evidence_digest FROM cards WHERE id='unrelated'").get()).toEqual({evidence_digest:null});
      // Job events project into the workspace (T07); a second drain is a no-op.
      expect(w.brain.projectOutbox()).toBeGreaterThanOrEqual(1);
      expect(w.brain.projectOutbox()).toBe(0);
      expect(ws.prepare("SELECT state FROM job_projection ORDER BY job_id").all().length).toBeGreaterThanOrEqual(1);
    } finally {await w.app.close();}
  });

  it.each(["jobId","workflowRunId","jobFence","sourceRevision","configDigest","workflowDigest"] as const)("rejects altered author %s before bundle or evaluator publication",async(field)=>{
    const w=await world();
    try {
      // The runner auto-captured the legitimate author bundle during world();
      // an altered resubmission must add nothing to that ledger.
      const before=(w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT COUNT(*) AS n FROM evidence_bundles").get() as {n:number}).n;
      const altered={...w.bundle,[field]:field==="jobFence"?w.bundle.jobFence+1:field.endsWith("Digest")?`sha256:${"f".repeat(64)}`:"not-the-author"};
      expect(()=>w.brain.submitEvidence(w.author,altered)).toThrow();
      expect(w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT COUNT(*) AS n FROM evidence_bundles").get()).toEqual({n:before});
      expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({n:1});
    } finally {await w.app.close();}
  });

  it("does not let another runner complete or submit the author's attempt (E073)",async()=>{
    const w=await world();
    try {
      expect(()=>w.brain.completeAttempt(w.evaluator,w.bundle.attemptId,{result:"failed",output:{},jobFence:w.bundle.jobFence,cleanupConfirmed:true})).toThrow(/another runner/);
      expect(()=>w.brain.submitEvidence(w.evaluator,w.bundle)).toThrow(/another runner/);
      expect((w.brain.store.control.prepare("SELECT state FROM jobs WHERE id=?").get(w.bundle.jobId) as {state:string}).state).toBe("verifying");
    } finally {await w.app.close();}
  });

  it.each(["invented-attempt","self-evaluation","wrong-identity","missing-check","wrong-oracle","receipt-mismatch","stale-epoch","trust-revoked","same-domain","stale-author-fence"])("rejects %s without accepting or completing author work",async(change)=>{
    const w=await admitted();
    try {
      let verdict=w.verdict;
      if(change==="invented-attempt")verdict={...verdict,evaluatorAttemptId:"invented"};
      if(change==="self-evaluation")verdict={...verdict,evaluatorAttemptId:w.bundle.attemptId};
      if(change==="wrong-identity")verdict={...verdict,acceptedBy:w.author.runnerId};
      if(change==="missing-check")verdict={...verdict,checks:verdict.checks.slice(0,1)};
      if(change==="wrong-oracle")verdict={...verdict,checks:verdict.checks.map(c=>({...c,oracleDigest:`sha256:${"f".repeat(64)}`}))};
      if(change==="receipt-mismatch")verdict={...verdict,checks:verdict.checks.map(c=>({...c,detail:"invented result"}))};
      if(change==="stale-epoch")w.brain.store.control.prepare("UPDATE runners SET session_epoch=session_epoch+1 WHERE id=?").run(w.evaluator.runnerId);
      if(change==="trust-revoked")w.brain.store.control.prepare("UPDATE runner_capabilities SET verified=0 WHERE runner_id=? AND capability LIKE 'trust:domain:%'").run(w.evaluator.runnerId);
      if(change==="same-domain")w.brain.store.control.prepare("UPDATE runner_capabilities SET capability='trust:domain:author-host' WHERE runner_id=? AND capability='trust:domain:evaluator-host'").run(w.evaluator.runnerId);
      if(change==="stale-author-fence")w.brain.store.control.prepare("UPDATE jobs SET job_fence=job_fence+1 WHERE id=?").run(w.bundle.jobId);
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,verdict)).toThrow();
      expect(w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get()).toEqual({n:0});
      expect((w.brain.store.control.prepare("SELECT state FROM jobs WHERE id=?").get(w.bundle.jobId) as {state:string}).state).toBe("verifying");
    } finally {await w.app.close();}
  });

  it("rehashes durable artifacts before both submission and acceptance (E074)",async()=>{
    const w=await admitted(addArtifact);
    try {
      writeFileSync(w.brain.casPath(w.bundle.artifacts[0]!.digest),"changed input");
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,w.verdict)).toThrow(/artifact bytes/);
      expect(w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get()).toEqual({n:0});
    } finally {await w.app.close();}
    const other=await world();
    try {
      const artifact=addArtifact(other);
      writeFileSync(other.brain.casPath(artifact.digest),"changed before submission");
      expect(()=>other.brain.submitEvidence(other.author,other.bundle)).toThrow(/artifact bytes/);
      expect(other.brain.store.workspaceDb(other.workspaceId,other.org).prepare("SELECT COUNT(*) AS n FROM evidence_bundles").get()).toEqual({n:0});
    } finally {await other.app.close();}
  });

  it("cannot use a passed check verdict to clear an unresolved external-effect guard",async()=>{
    const w=await admitted();
    try {
      w.brain.store.control.prepare("INSERT INTO resource_fences(resource_key,organization_id,counter) VALUES ('guard-test',?,1)").run(w.org);
      w.brain.store.control.prepare("INSERT INTO resource_leases(resource_key,attempt_id,invocation_id,fence,expires_at_ms,unresolved_effect) VALUES ('guard-test',?,'unknown-invocation',1,?,1)").run(w.bundle.attemptId,w.brain.store.now()+60_000);
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,w.verdict)).toThrow(/reconciliation/);
      expect(w.brain.store.control.prepare("SELECT unresolved_effect FROM resource_leases WHERE resource_key='guard-test'").get()).toEqual({unresolved_effect:1});
    } finally {await w.app.close();}
  });

  it("does not accept a new verdict after cancellation",async()=>{
    const w=await admitted();
    try {
      w.brain.executeCommand(w.owner,{contractVersion:"brain.command/v1",commandId:"cancel-evidence",commandType:"workflow.cancel",workspaceId:w.workspaceId,idempotencyKey:"cancel-evidence",payload:{runId:w.bundle.workflowRunId,reason:"Stop evaluation"}},"cancel-evidence");
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,w.verdict)).toThrow(/terminal workflow/);
      expect(w.brain.store.workspaceDb(w.workspaceId,w.org).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get()).toEqual({n:0});
    } finally {await w.app.close();}
  });

  it("retries durable finalization after a fault between control/workflow completion and the final marker",async()=>{
    const w=await admitted();
    try {
      const ws=w.brain.store.workspaceDb(w.workspaceId,w.org);
      ws.exec("CREATE TRIGGER fail_finalization BEFORE UPDATE OF finalized_at_ms ON verification_verdicts BEGIN SELECT RAISE(ABORT,'injected finalization fault'); END");
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,w.verdict)).toThrow(/injected/);
      expect(ws.prepare("SELECT finalized_at_ms FROM verification_verdicts").get()).toEqual({finalized_at_ms:null});
      ws.exec("DROP TRIGGER fail_finalization");
      w.brain.projectOutbox();
      const final=ws.prepare("SELECT id,finalized_at_ms FROM verification_verdicts").get() as {id:string;finalized_at_ms:number};
      expect(final.finalized_at_ms).toBeGreaterThan(0);
      expect(w.brain.acceptVerdict(w.evaluator,w.workspaceId,w.verdict)).toMatchObject({verdictId:final.id,outcome:"verified"});
      expect(()=>w.brain.acceptVerdict(w.evaluator,w.workspaceId,{...w.verdict,outcome:"rejected"})).toThrow(/immutable/);
    } finally {await w.app.close();}
  });
});
