import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { receiptSignatureOk, RUN_RECEIPT_VERSION, runnerKeyId, signReceipt, type RunReceipt } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { actingAs, runnerActor } from "../../apps/governor/src/application/actor-context";
import { recordRunnerKey } from "../../apps/governor/src/modules/jobs/protocol";

/**
 * Tests that stand in for a runner at the Governor seam (they call `jobProtocol.complete` themselves) must still hand the Governor a receipt
 * signed with an enrolled key: there is no unsigned path (ADR 0078). This gives each such runner a real ed25519 key, enrolled through the
 * same recording the Governor does at enrollment, and signs the receipt of the attempt being completed with it. The Governor verifies it
 * exactly as it does a real runner's. A runner enrolled for real (a runner process with its own state directory) is registered with
 * `useRunnerKey` instead, so the receipt is signed with the key it enrolled with.
 */
interface Signing { keyId: string; privateKeyPem: string }
// Keyed by the data directory so a Governor restarted on the same data keeps signing with the key its runner enrolled, as a real runner does.
const signers = new Map<string, Map<string, Signing>>();
// A runner that repeats a completion it never saw acknowledged sends the same receipt, signature and all.
const sent = new Map<string, { receipt: RunReceipt; signature: string }>();

function table(brain: Brain): Map<string, Signing> {
  let t = signers.get(brain.store.dataDir);
  if (!t) { t = new Map(); signers.set(brain.store.dataDir, t); }
  return t;
}

/** Signs this runner's receipts with a key it enrolled for real (the private half is in its state directory). */
export function useRunnerKey(brain: Brain, runnerId: string, keys: { publicKeyPem: string; privateKeyPem: string }): void {
  table(brain).set(runnerId, { keyId: runnerKeyId(keys.publicKeyPem), privateKeyPem: keys.privateKeyPem });
}

/** The signing key of a runner seeded straight into the tables: enrolled on first use. */
function signingFor(brain: Brain, organizationId: string, runnerId: string, attemptId: string): Signing {
  const t = table(brain);
  const known = t.get(runnerId);
  if (known) return known;
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = (pair.publicKey as KeyObject).export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = (pair.privateKey as KeyObject).export({ type: "pkcs8", format: "pem" }).toString();
  const keyId = actingAs(runnerActor(runnerId, attemptId), () => brain.store.inTx(brain.store.control, () => recordRunnerKey(brain.store, organizationId, runnerId, publicKeyPem)));
  const signing = { keyId, privateKeyPem };
  t.set(runnerId, signing);
  return signing;
}

/** The receipt of the attempt as the runner would state it, from what the Governor holds (the test has no engine to ask). */
export function receiptFor(brain: Brain, runner: { runnerId: string; epoch: number }, attemptId: string, body: Record<string, unknown>, keyId: string): RunReceipt | undefined {
  const row = brain.store.control.prepare(`SELECT a.id, a.job_id, a.job_fence, j.workflow_run_id, j.step_id, j.config_digest, j.execution_digest FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(attemptId) as
    | { id: string; job_id: string; job_fence: number; workflow_run_id: string; step_id: string; config_digest: string; execution_digest: string } | undefined;
  if (!row) return undefined;
  const now = new Date(brain.store.now()).toISOString();
  return {
    contractVersion: RUN_RECEIPT_VERSION, attemptId: row.id, jobId: row.job_id, jobFence: row.job_fence, runnerId: runner.runnerId, runnerEpoch: runner.epoch,
    workflowRunId: row.workflow_run_id, stepId: row.step_id, configDigest: row.config_digest, executionDigest: row.execution_digest, keyId,
    engine: { id: "fixture", version: null, route: null }, startedAt: now, endedAt: now, outcome: String(body["result"]) as RunReceipt["outcome"],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 }, evidenceDigest: null, artifactDigests: [],
  };
}

/** `body` with the receipt and signature the runner would send; a body that already carries a receipt is left alone. */
export function withSignedReceipt(brain: Brain, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): Record<string, unknown> {
  if (body["receipt"] !== undefined || body["signature"] !== undefined) return body;
  const signing = signingFor(brain, runner.organizationId, runner.runnerId, attemptId);
  const again = sent.get(`${brain.store.dataDir}|${attemptId}|${String(body["result"])}`);
  if (again) return { ...body, receipt: again.receipt, signature: again.signature };
  const receipt = receiptFor(brain, runner, attemptId, body, signing.keyId);
  if (!receipt) return body;
  const signature = signReceipt(receipt, signing.privateKeyPem);
  sent.set(`${brain.store.dataDir}|${attemptId}|${String(body["result"])}`, { receipt, signature });
  if (!receiptSignatureOk(receipt, signature, (brain.store.control.prepare("SELECT public_key_spki_pem AS pem FROM runner_keys WHERE key_id=?").get(signing.keyId) as { pem: string }).pem)) throw new Error("test signer produced a receipt that does not verify");
  return { ...body, receipt, signature };
}

/** Makes a job protocol's `complete` hand the Governor a signed receipt, for tests that complete attempts themselves. */
const wrapped = new WeakSet<object>();
export function signProtocol<P extends Brain["jobProtocol"]>(brain: Brain, protocol: P): P {
  if (wrapped.has(protocol)) return protocol;
  wrapped.add(protocol);
  const complete = protocol.complete.bind(protocol);
  protocol.complete = (runner, attemptId, body) => complete(runner, attemptId, withSignedReceipt(brain, runner, attemptId, body));
  return protocol;
}

/** The same for the brain's own protocol (what its callers and the HTTP routes use). */
export function signCompletions(brain: Brain): Brain {
  signProtocol(brain, brain.jobProtocol);
  return brain;
}
