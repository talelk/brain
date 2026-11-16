import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECEIPT_EVENT, receiptSignatureOk, runnerKeyId, signReceipt, verifyAuditExport, type AuditExportInput, type RunReceipt } from "@brain/contracts";
import { quarantineRestoredAuthority } from "../../apps/governor/src/modules/operations/index";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, loadOrCreateKeys, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { bundleForAttempt } from "../support/evidence";
import { chainOf, exportWith, withPayload } from "../support/audit-forge";
import { receiptFor } from "../support/signed-completion";

// Signed run receipts (ADR 0078, #153). The Governor seam: a completion is accepted only with the receipt the runner signed with its
// ENROLLED key. State is built through commands and the runner protocol; the forged exports below are the attack under test.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const hex = (n: number) => "a".repeat(n);
type Offer = { attemptId: string; jobId: string; leaseId: string; jobFence: number };

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "brain-receipts-"));
  const app = await createApp({ dataDir: dir, allowTestActor: true });
  cleanups.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const w = setupWorld(app.brain);
  const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const config = (stateName: string, runnerId = "receipt-runner"): RunnerConfig => ({ runnerId, governorUrl: "http://127.0.0.1:3000", stateDir: join(w.dir, stateName), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] });
  const enroll = async (cfg: RunnerConfig) => {
    const hello = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "fixture-tools").token);
    return { cfg, runner: { runnerId: cfg.runnerId, epoch: hello.epoch, organizationId: w.org }, keys: loadOrCreateKeys(cfg.stateDir), session: hello };
  };
  const first = await enroll(config("runner-a"));
  const command = (type: string, key: string, payload: Record<string, unknown>) => w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: w.workspaceId, idempotencyKey: key, payload } as never, key);
  const dispatch = async (key: string) => {
    const release = w.brain.activeRelease(w.org)!.digest;
    expect((await command("workflow.dispatch", key, { workflow: { id: "fixture-workflow", digest: release }, input: { message: "Brain fixture" } })).receipt.accepted).toBe(true);
  };
  const claim = (runner: { runnerId: string; epoch: number; organizationId: string }, key: string): Offer => {
    const offer = w.brain.jobProtocol.claim(runner, key) as unknown as Offer;
    w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    return offer;
  };
  /** The receipt the runner states for this attempt, signed with `keys` (by default the key it enrolled with). */
  const signed = (runner: { runnerId: string; epoch: number }, offer: Offer, result: "succeeded" | "failed", keys: { publicKeyPem: string; privateKeyPem: string }, edit: (r: RunReceipt) => RunReceipt = (r) => r) => {
    const receipt = edit(receiptFor(w.brain, runner, offer.attemptId, { result }, runnerKeyId(keys.publicKeyPem))!);
    return { receipt, signature: signReceipt(receipt, keys.privateKeyPem) };
  };
  const complete = (runner: { runnerId: string; epoch: number; organizationId: string }, offer: Offer, result: "succeeded" | "failed", extra: Record<string, unknown>) =>
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result, output: result === "failed" ? { error: "stopped for the test" } : { message: "Brain fixture", bytes: 13 }, jobFence: offer.jobFence, cleanupConfirmed: true, ...extra });
  const receiptRow = (attemptId: string) => w.brain.store.control.prepare("SELECT * FROM attempt_receipts WHERE attempt_id=?").get(attemptId) as Record<string, unknown> | undefined;
  const exportInput = (): AuditExportInput => w.brain.audit.exportInput(w.org);
  return { ...w, app, config, enroll, first, command, dispatch, claim, signed, complete, receiptRow, exportInput };
}

describe("a completion carries the receipt its runner signed", () => {
  it("accepts a receipt signed with the enrolled key, keeps it as signed and writes it into the audit chain", async () => {
    const x = await world();
    await x.dispatch("good");
    const offer = x.claim(x.first.runner, "claim-good");
    const { receipt, signature } = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    const done = x.complete(x.first.runner, offer, "succeeded", { receipt, signature }) as { jobState: string };
    expect(done.jobState).toBe("verifying");

    const stored = x.receiptRow(offer.attemptId)!;
    expect(JSON.parse(String(stored["receipt_json"]))).toEqual(receipt);
    expect(stored["signature"]).toBe(signature);
    expect(stored["key_id"]).toBe(runnerKeyId(x.first.keys.publicKeyPem));
    // The receipt is an event of the control chain, after the runner's key was recorded there.
    const control = chainOf(x.exportInput(), "control");
    const enrolled = control.findIndex((e) => e.eventType === "runner.keyEnrolled" && JSON.parse(e.payloadJson).runnerId === "receipt-runner");
    const receipted = control.findIndex((e) => e.eventType === RECEIPT_EVENT && e.aggregateId === offer.attemptId);
    expect(enrolled).toBeGreaterThanOrEqual(0);
    expect(receipted).toBeGreaterThan(enrolled);
    expect(JSON.parse(control[receipted]!.payloadJson)).toMatchObject({ receipt, signature, receiptDigest: stored["receipt_digest"] });
    expect(x.brain.audit.verifyNow(x.org)).toMatchObject({ ok: true });
  });

  it("refuses a receipt that names no evidence bundle when the attempt submits one, and accepts it once it names the bundle's digest", async () => {
    const x = await world();
    await x.dispatch("unbound");
    const offer = x.claim(x.first.runner, "claim-unbound");
    const unbound = x.signed(x.first.runner, offer, "succeeded", x.first.keys, (r) => ({ ...r, evidenceDigest: null }));
    expect(() => x.complete(x.first.runner, offer, "succeeded", unbound)).toThrow(/RECEIPT_EVIDENCE_UNBOUND/);
    expect(x.receiptRow(offer.attemptId)).toBeUndefined();
    const bound = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    expect(bound.receipt.evidenceDigest).toMatch(/^sha256:/);
    expect((x.complete(x.first.runner, offer, "succeeded", bound) as { jobState: string }).jobState).toBe("verifying");
    // The bundle the receipt names is the only one the Governor takes for this attempt.
    expect(() => x.brain.submitEvidence(x.first.runner, { ...bundleForAttempt(x.brain, x.org, x.workspaceId, offer.attemptId, "bundle-x"), createdAt: "2001-01-01T00:00:00.000Z" })).toThrow(/signed receipt names/);
  });

  it("refuses a completion with no receipt, or no signature, and leaves the attempt running", async () => {
    const x = await world();
    await x.dispatch("unsigned");
    const offer = x.claim(x.first.runner, "claim-unsigned");
    const { receipt } = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    // The test world signs for tests that do not mention a receipt; an explicitly empty one is how a runner that never signs would look.
    expect(() => x.complete(x.first.runner, offer, "succeeded", { signature: "" })).toThrow(/RECEIPT_UNSIGNED/);
    expect(() => x.complete(x.first.runner, offer, "succeeded", { receipt, signature: "" })).toThrow(/RECEIPT_UNSIGNED/);
    expect(() => x.complete(x.first.runner, offer, "succeeded", { receipt: { ...receipt, extra: 1 }, signature: "AAAA" })).toThrow(/RECEIPT_INVALID/);
    expect(x.receiptRow(offer.attemptId)).toBeUndefined();
    const { receipt: good, signature } = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    expect((x.complete(x.first.runner, offer, "succeeded", { receipt: good, signature }) as { jobState: string }).jobState).toBe("verifying");
  });

  it("refuses a receipt changed after signing, signed by another key, or from a key this runner never enrolled", async () => {
    const x = await world();
    await x.dispatch("tamper");
    const offer = x.claim(x.first.runner, "claim-tamper");
    const stranger = generateKeyPairSync("ed25519");
    const strangerKeys = { publicKeyPem: stranger.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: stranger.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const real = x.signed(x.first.runner, offer, "succeeded", x.first.keys);

    // A field changed after signing.
    const edited = { receipt: { ...real.receipt, usage: { ...real.receipt.usage, microUsd: 1 } }, signature: real.signature };
    expect(() => x.complete(x.first.runner, offer, "succeeded", edited)).toThrow(/RECEIPT_SIGNATURE_INVALID/);
    // The enrolled key's id on a receipt somebody else signed.
    const forged = x.signed(x.first.runner, offer, "succeeded", strangerKeys, (r) => ({ ...r, keyId: runnerKeyId(x.first.keys.publicKeyPem) }));
    expect(() => x.complete(x.first.runner, offer, "succeeded", forged)).toThrow(/RECEIPT_SIGNATURE_INVALID/);
    // A key that was never enrolled.
    const unknown = x.signed(x.first.runner, offer, "succeeded", strangerKeys);
    expect(() => x.complete(x.first.runner, offer, "succeeded", unknown)).toThrow(/RECEIPT_KEY_UNKNOWN/);
    // A claim the Governor knows to be false: another configuration, another outcome.
    const other = x.signed(x.first.runner, offer, "succeeded", x.first.keys, (r) => ({ ...r, configDigest: `sha256:${hex(64)}` }));
    expect(() => x.complete(x.first.runner, offer, "succeeded", other)).toThrow(/RECEIPT_MISMATCH.*configuration/);
    expect(() => x.complete(x.first.runner, offer, "failed", real)).toThrow(/RECEIPT_MISMATCH.*outcome/);
    expect(x.receiptRow(offer.attemptId)).toBeUndefined();
  });

  it("refuses another runner's key and a receipt replayed for another attempt", async () => {
    const x = await world();
    const second = await x.enroll(x.config("runner-b", "receipt-runner-2"));
    await x.dispatch("replay-1");
    const offer = x.claim(x.first.runner, "claim-replay-1");
    const real = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    // The other runner's key does not stand in for this runner's.
    const swapped = x.signed(x.first.runner, offer, "succeeded", second.keys);
    expect(() => x.complete(x.first.runner, offer, "succeeded", swapped)).toThrow(/RECEIPT_KEY_UNKNOWN/);
    x.complete(x.first.runner, offer, "succeeded", real);

    await x.dispatch("replay-2");
    const next = x.claim(second.runner, "claim-replay-2");
    // The first attempt's receipt, signature and all, presented for this one.
    expect(() => x.complete(second.runner, next, "succeeded", real)).toThrow(/RECEIPT_MISMATCH/);
    expect(x.receiptRow(next.attemptId)).toBeUndefined();
  });
});

describe("receipts verify offline, against the runner keys the chain recorded", () => {
  async function receipted() {
    const x = await world();
    await x.dispatch("offline");
    const offer = x.claim(x.first.runner, "claim-offline");
    const { receipt, signature } = x.signed(x.first.runner, offer, "succeeded", x.first.keys);
    x.complete(x.first.runner, offer, "succeeded", { receipt, signature });
    const input = x.exportInput();
    const control = chainOf(input, "control");
    const at = control.findIndex((e) => e.eventType === RECEIPT_EVENT);
    return { x, offer, input, control, at };
  }
  const verifyForged = (input: AuditExportInput, events: Parameters<typeof exportWith>[1]) => verifyAuditExport(exportWith(input, events));

  it("verifies the honest export, receipts included", async () => {
    const { x, input, control } = await receipted();
    expect(control.some((e) => e.eventType === RECEIPT_EVENT)).toBe(true);
    expect(verifyAuditExport(input)).toMatchObject({ ok: true });
    expect(verifyForged(input, control)).toMatchObject({ ok: true });
    expect(x.receiptRow(String(JSON.parse(control.find((e) => e.eventType === RECEIPT_EVENT)!.payloadJson).receipt.attemptId))).toBeDefined();
  });

  it("finds a receipt field changed after signing, even when every digest after the edit is recomputed", async () => {
    const { input, control, at } = await receipted();
    const forged = control.map((e, i) => i === at ? withPayload(e, (p) => { (p["receipt"] as { usage: { microUsd: number } }).usage.microUsd = 777; }) : e);
    const result = verifyForged(input, forged);
    expect(result.ok).toBe(false);
    expect(result.break).toMatchObject({ kind: "event-check", chainSeq: at + 1 });
    expect(result.break!.detail).toMatch(/run receipt: the receipt of attempt \S+ does not carry a valid signature from runner receipt-runner/);
  });

  it("finds a receipt with its signature removed, or one signed by a key the chain never recorded", async () => {
    const { input, control, at } = await receipted();
    const unsigned = control.map((e, i) => i === at ? withPayload(e, (p) => { delete p["signature"]; }) : e);
    expect(verifyForged(input, unsigned).break!.detail).toMatch(/carries no signature/);
    const stranger = generateKeyPairSync("ed25519");
    const strangerPem = stranger.publicKey.export({ type: "spki", format: "pem" }).toString();
    const resigned = control.map((e, i) => i === at ? withPayload(e, (p) => {
      const receipt = { ...(p["receipt"] as RunReceipt), keyId: runnerKeyId(strangerPem) };
      p["receipt"] = receipt; p["signature"] = signReceipt(receipt, stranger.privateKey.export({ type: "pkcs8", format: "pem" }).toString()); delete p["receiptDigest"];
    }) : e);
    expect(verifyForged(input, resigned).break!.detail).toMatch(/which no runner enrollment in the audit log introduced/);
  });

  it("finds a receipt signed by another runner's key, and a receipt moved to another attempt", async () => {
    const x = await world();
    const second = await x.enroll(x.config("runner-b", "receipt-runner-2"));
    await x.dispatch("borrowed");
    const offer = x.claim(x.first.runner, "claim-borrowed");
    x.complete(x.first.runner, offer, "succeeded", x.signed(x.first.runner, offer, "succeeded", x.first.keys));
    const input = x.exportInput();
    const control = chainOf(input, "control");
    const at = control.findIndex((e) => e.eventType === RECEIPT_EVENT);
    const borrowed = control.map((e, i) => i === at ? withPayload(e, (p) => {
      const receipt = { ...(p["receipt"] as RunReceipt), keyId: runnerKeyId(second.keys.publicKeyPem) };
      p["receipt"] = receipt; p["signature"] = signReceipt(receipt, second.keys.privateKeyPem); delete p["receiptDigest"];
    }) : e);
    expect(verifyForged(input, borrowed).break!.detail).toMatch(/claims runner receipt-runner but key rk-\S+ was enrolled by runner receipt-runner-2/);
    // The same receipt under another attempt's event: a replay.
    const moved = control.map((e, i) => i === at ? { ...e, aggregateId: "attempt-someone-else" } : e);
    expect(verifyForged(input, moved).break!.detail).toMatch(/names attempt \S+: a receipt was moved to another attempt/);
    // The same receipt twice.
    const twice = [...control.slice(0, at + 1), control[at]!, ...control.slice(at + 1)];
    expect(verifyForged(input, twice).break!.detail).toMatch(/appears twice in the log/);
  });

  it("refuses a receipt signed after its key was rotated, and keeps one signed before", async () => {
    const x = await world();
    // Signed before the rotation: a failed attempt (so no attempt is left open and the runner can be rotated).
    await x.dispatch("before");
    const before = x.claim(x.first.runner, "claim-before");
    x.complete(x.first.runner, before, "failed", x.signed(x.first.runner, before, "failed", x.first.keys));
    const oldKeys = x.first.keys;

    for (const action of ["disable", "rotate"]) {
      expect((await x.command("runner.control", `rotate-${action}`, { runnerId: "receipt-runner", action, reason: `receipts ${action}` })).receipt.accepted).toBe(true);
    }
    const revoked = x.exportInput();
    const revokedAt = chainOf(revoked, "control").findIndex((e) => e.eventType === "runner.rotated");
    expect(JSON.parse(chainOf(revoked, "control")[revokedAt]!.payloadJson).revokedKeyIds).toEqual([runnerKeyId(oldKeys.publicKeyPem)]);
    // What was signed before the revocation still verifies, offline and on the Governor.
    expect(verifyAuditExport(revoked)).toMatchObject({ ok: true });
    expect(x.receiptRow(before.attemptId)).toBeDefined();

    // The runner comes back with a new key. (Re-enrolling leaves it disabled with no heartbeat, and a disabled runner's hello is refused, so the
    // arrangement gives it the heartbeat its hello would have; the operator's enable is a real command.)
    const fresh = generateKeyPairSync("ed25519");
    const renewedKeys = { publicKeyPem: fresh.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: fresh.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    x.brain.jobProtocol.enrollRunner({ token: x.brain.jobProtocol.issueEnrollment(x.owner, "fixture-tools").token, publicKeyPem: renewedKeys.publicKeyPem, runnerId: "receipt-runner" });
    x.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='receipt-runner'").run(x.brain.store.now());
    expect((await x.command("runner.control", "rotate-enable", { runnerId: "receipt-runner", action: "enable", reason: "back in service" })).receipt.accepted).toBe(true);
    const epoch = (x.brain.store.control.prepare("SELECT session_epoch AS e FROM runners WHERE id='receipt-runner'").get() as { e: number }).e;
    const renewed = { runner: { runnerId: "receipt-runner", epoch, organizationId: x.org }, keys: renewedKeys };
    await x.dispatch("after");
    const after = x.claim(renewed.runner, "claim-after");
    expect(() => x.complete(renewed.runner, after, "failed", x.signed(renewed.runner, after, "failed", oldKeys))).toThrow(/RECEIPT_KEY_REVOKED/);
    x.complete(renewed.runner, after, "failed", x.signed(renewed.runner, after, "failed", renewed.keys));
    const full = x.exportInput();
    expect(verifyAuditExport(full)).toMatchObject({ ok: true });

    // Offline: the same refusal when the log itself is forged to hold a receipt of the old key after the revocation.
    const control = chainOf(full, "control");
    const lateIndex = control.findIndex((e) => e.eventType === RECEIPT_EVENT && e.aggregateId === after.attemptId);
    const late = control.map((e, i) => i === lateIndex ? withPayload(e, (p) => {
      const receipt = { ...(p["receipt"] as RunReceipt), keyId: runnerKeyId(oldKeys.publicKeyPem) };
      p["receipt"] = receipt; p["signature"] = signReceipt(receipt, oldKeys.privateKeyPem); delete p["receiptDigest"];
    }) : e);
    const result = verifyAuditExport(exportWith(full, late));
    expect(result.break).toMatchObject({ kind: "event-check" });
    expect(result.break!.detail).toMatch(/after runner receipt-runner had rotated or retired it/);
  });

  it("the stored receipt cannot be rewritten or removed", async () => {
    const { x, offer } = await receipted();
    const db = x.brain.store.control;
    expect(() => db.prepare("UPDATE attempt_receipts SET receipt_json='{}' WHERE attempt_id=?").run(offer.attemptId)).toThrow(/never rewritten/);
    expect(() => db.prepare("DELETE FROM attempt_receipts WHERE attempt_id=?").run(offer.attemptId)).toThrow(/never removed/);
  });
});

describe("the runner signs what it did", () => {
  it("a real runner's completion carries a receipt of its attempt, signed with its enrolled key, and the evidence it names is the bundle it submits", async () => {
    const x = await world();
    await x.dispatch("runner-seam");
    expect(await runOnce(x.first.cfg, x.first.session.sessionToken, x.first.session.epoch)).toBe(true);
    const attempt = x.brain.store.control.prepare("SELECT attempt_id, receipt_json, signature, evidence_digest, key_id FROM attempt_receipts").get() as { attempt_id: string; receipt_json: string; signature: string; evidence_digest: string | null; key_id: string };
    const receipt = JSON.parse(attempt.receipt_json) as RunReceipt;
    expect(receipt).toMatchObject({ contractVersion: "brain.run-receipt/v1", attemptId: attempt.attempt_id, runnerId: "receipt-runner", outcome: "succeeded", stepId: "echo", keyId: runnerKeyId(x.first.keys.publicKeyPem) });
    expect(receiptSignatureOk(receipt, attempt.signature, x.first.keys.publicKeyPem)).toBe(true);
    expect(receipt.engine.id).toBeTruthy();
    expect(Date.parse(receipt.endedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
    expect(receipt.artifactDigests.length).toBeGreaterThan(0);
    // The evidence digest the runner signed is the bundle the Governor holds.
    const bundle = x.brain.store.workspaceDb(x.workspaceId, x.org).prepare("SELECT digest FROM evidence_bundles WHERE attempt_id=?").get(attempt.attempt_id) as { digest: string };
    expect(receipt.evidenceDigest).toBe(bundle.digest);
    // A bundle that is not the one the runner signed for is refused.
    const other = { ...bundleForAttempt(x.brain, x.org, x.workspaceId, attempt.attempt_id, "bundle-someone-elses"), sourceRevision: "not-the-signed-one" };
    expect(() => x.brain.submitEvidence(x.first.runner, other)).toThrow();
    // The run's evidence shows who signed it, and that it checks out.
    const view = (await x.brain.executeQuery(x.owner, { queryType: "evidence.get", workspaceId: x.workspaceId, resourceId: bundle.digest })) as { snapshot: { receipt?: { signedBy: { runnerId: string; verified: boolean }; digest: string } } };
    expect(view.snapshot.receipt).toMatchObject({ signedBy: { runnerId: "receipt-runner", keyId: runnerKeyId(x.first.keys.publicKeyPem), verified: true } });
    expect(view.snapshot.receipt!.digest).toMatch(/^sha256:/);
    expect(verifyAuditExport(x.exportInput())).toMatchObject({ ok: true });
  });
});

describe("a restore ends the runner keys in the audit chain too", () => {
  it("writes the revocation as a system:restore event, so the offline verifier and the Governor agree", async () => {
    const x = await world();
    const keyId = runnerKeyId(x.first.keys.publicKeyPem);
    writeFileSync(join(x.brain.store.dataDir, "RESTORED-SUSPENDED.json"), JSON.stringify({ format: "brain.restore/v1", restoreId: randomUUID(), backupId: randomUUID(), manifestDigest: `sha256:${hex(64)}`, restoredAt: new Date().toISOString() }));
    quarantineRestoredAuthority(x.brain.store, { revokeAllSessions() {} });
    expect((x.brain.store.control.prepare("SELECT revoked_at_ms FROM runner_keys WHERE key_id=?").get(keyId) as { revoked_at_ms: number | null }).revoked_at_ms).not.toBeNull();
    const input = x.exportInput();
    const revoked = chainOf(input, "control").find((e) => e.eventType === "runner.keysRevoked");
    expect(revoked).toBeDefined();
    expect(JSON.parse(revoked!.payloadJson).revokedKeyIds).toContain(keyId);
    expect(JSON.stringify(revoked)).toContain("system:restore");
    expect(verifyAuditExport(input)).toMatchObject({ ok: true });
  });
});
