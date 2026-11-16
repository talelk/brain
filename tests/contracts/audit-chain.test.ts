import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTROL_SCOPE, KEY_RECORDED_EVENT, auditChainDigest, auditGenesis, auditKeyId, checkpointSigningBytes, domainDigest, rotationSigningBytes, verifyAuditExport,
  type AuditCheckpoint, type AuditEventRecord, type AuditExportInput, type AuditKey,
} from "@brain/contracts";

// The verifier on synthetic exports: it is a pure function, so a chain, keys and checkpoints are built here with the same digest
// functions the Governor writes with, and each way of tampering is applied to the data itself. (The Governor seam is covered in
// tests/integration/audit-chain.test.ts.)

const ORG = "org-x";
const newKey = () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { keyId: auditKeyId(publicKey), publicKey, privateKey: pair.privateKey };
};
type Key = ReturnType<typeof newKey>;
const asKey = (k: Key): AuditKey => ({ keyId: k.keyId, algorithm: "ed25519", publicKey: k.publicKey, createdAtMs: 1, retiredAtMs: null });

function chain(scope: string, payloads: Array<{ type?: string; payload: Record<string, unknown> }>): AuditEventRecord[] {
  const out: AuditEventRecord[] = [];
  let prev = auditGenesis(ORG, scope);
  payloads.forEach(({ type, payload }, i) => {
    const payloadJson = JSON.stringify(payload);
    const base = {
      eventId: `evt-${scope}-${i + 1}`, organizationId: scope === CONTROL_SCOPE ? ORG : null, workspaceId: null, aggregateType: "thing", aggregateId: "t1", aggregateSeq: i + 1, eventType: type ?? "thing.happened",
      payloadDigest: domainDigest("brain:event:v1", payload as never), createdAtMs: 1000 + i, actorId: "owner-1", actorKind: "human", actorAttemptId: null, actingFor: null,
    };
    const chainDigest = auditChainDigest(prev, i + 1, base);
    out.push({ ...base, chainSeq: i + 1, cursor: i + 1, payloadJson, prevDigest: prev, chainDigest });
    prev = chainDigest;
  });
  return out;
}
function checkpoint(key: Key, scope: string, events: AuditEventRecord[], at: number, reason: AuditCheckpoint["reason"] = "schedule"): AuditCheckpoint {
  const head = events[at - 1]!;
  const body = { checkpointId: `ck-${scope}-${at}`, organizationId: ORG, scope, throughSeq: at, chainDigest: head.chainDigest!, createdAtMs: 5000 + at, reason, keyId: key.keyId };
  return { ...body, signature: sign(null, checkpointSigningBytes(body), key.privateKey).toString("base64") };
}
const keyEvent = (key: Key, previous?: Key) => ({ type: KEY_RECORDED_EVENT, payload: { keyId: key.keyId, publicKey: key.publicKey, previousKeyId: previous?.keyId ?? null, rotationSignature: previous ? sign(null, rotationSigningBytes(previous.keyId, key.keyId, key.publicKey), previous.privateKey).toString("base64") : null } });

const key1 = newKey();
const good = (): { control: AuditEventRecord[]; ws: AuditEventRecord[]; input: AuditExportInput } => {
  const control = chain(CONTROL_SCOPE, [keyEvent(key1), ...[1, 2, 3, 4, 5].map((n) => ({ payload: { n } }))]);
  const ws = chain("workspace:w1", [1, 2, 3, 4].map((n) => ({ payload: { n } })));
  return { control, ws, input: { organizationId: ORG, keys: [asKey(key1)], chains: [{ scope: CONTROL_SCOPE, events: control, checkpoints: [checkpoint(key1, CONTROL_SCOPE, control, 4)] }, { scope: "workspace:w1", events: ws, checkpoints: [checkpoint(key1, "workspace:w1", ws, 3)] }] } };
};
const withEvents = (input: AuditExportInput, scope: string, events: AuditEventRecord[]): AuditExportInput => ({ ...input, chains: input.chains.map((c) => c.scope === scope ? { ...c, events } : c) });

describe("verifying an audit export", () => {
  it("accepts an untouched export and says what it checked", () => {
    const r = verifyAuditExport(good().input);
    expect(r).toMatchObject({ ok: true, verifiedEvents: 10, checkpointsVerified: 2, keysPinned: false, warnings: [] });
    expect(r.chains.find((c) => c.scope === CONTROL_SCOPE)?.head?.seq).toBe(6);
  });

  it("finds an edited payload, an edited column and a payload digest rewritten to match", () => {
    const { control, input } = good();
    const edit = (patch: Partial<AuditEventRecord>) => verifyAuditExport(withEvents(input, CONTROL_SCOPE, control.map((e) => e.chainSeq === 3 ? { ...e, ...patch } : e)));
    expect(edit({ payloadJson: '{"n":99}' }).break).toMatchObject({ kind: "payload-edited", chain: CONTROL_SCOPE, chainSeq: 3, eventId: control[2]!.eventId });
    expect(edit({ actorId: "someone-else" }).break).toMatchObject({ kind: "event-edited", chainSeq: 3 });
    expect(edit({ createdAtMs: 1 }).break).toMatchObject({ kind: "event-edited", chainSeq: 3 });
    expect(edit({ payloadJson: '{"n":99}', payloadDigest: domainDigest("brain:event:v1", { n: 99 }) }).break).toMatchObject({ kind: "event-edited", chainSeq: 3 });
  });

  it("finds a removed, an added and a reordered event, where it happened", () => {
    const { control, input } = good();
    const removed = verifyAuditExport(withEvents(input, CONTROL_SCOPE, control.filter((e) => e.chainSeq !== 3)));
    expect(removed.break).toMatchObject({ kind: "sequence-gap", chainSeq: 4 });
    expect(removed.verifiedEvents).toBe(2 + 4);
    const first = verifyAuditExport(withEvents(input, CONTROL_SCOPE, control.slice(1)));
    expect(first.break).toMatchObject({ kind: "sequence-gap", chainSeq: 2 });
    const reordered = [...control]; [reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
    expect(verifyAuditExport(withEvents(input, CONTROL_SCOPE, reordered)).break).toMatchObject({ kind: "sequence-gap", chainSeq: 4 });
    const added = verifyAuditExport(withEvents(input, CONTROL_SCOPE, [...control.slice(0, 3), { ...control[2]!, eventId: "evt-injected", chainSeq: null, prevDigest: null, chainDigest: null }, ...control.slice(3)]));
    expect(added.break).toMatchObject({ kind: "unchained-event", eventId: "evt-injected" });
  });

  it("finds a chain rebuilt after an edit because a signed checkpoint remembers the old history", () => {
    const { control, input } = good();
    const rebuilt = chain(CONTROL_SCOPE, control.map((e, i) => ({ ...(e.eventType === KEY_RECORDED_EVENT ? { type: KEY_RECORDED_EVENT } : {}), payload: i === 2 ? { n: 777 } : JSON.parse(e.payloadJson) as Record<string, unknown> })));
    expect(rebuilt.every((e) => e.chainDigest)).toBe(true);
    const r = verifyAuditExport(withEvents(input, CONTROL_SCOPE, rebuilt));
    expect(r.ok).toBe(false);
    expect(r.break).toMatchObject({ kind: "checkpoint-mismatch", chain: CONTROL_SCOPE, chainSeq: 4 });
  });

  it("finds a tail cut after a checkpoint, and says plainly that a cut before the first checkpoint is not provable", () => {
    const { control, input } = good();
    expect(verifyAuditExport(withEvents(input, CONTROL_SCOPE, control.slice(0, 3))).break).toMatchObject({ kind: "tail-truncated", chainSeq: 4 });
    // After the last checkpoint (position 4) nothing remembers the end of the log: the chain alone cannot tell.
    expect(verifyAuditExport(withEvents(input, CONTROL_SCOPE, control.slice(0, 5))).ok).toBe(true);
  });

  it("finds a checkpoint that is forged, unsigned by a trusted key, or for another log", () => {
    const { control, input } = good();
    const other = newKey();
    const cp = input.chains[0]!.checkpoints[0]!;
    const run = (c: AuditCheckpoint, keys: AuditKey[] = input.keys as AuditKey[]) => verifyAuditExport({ ...input, keys, chains: [{ ...input.chains[0]!, checkpoints: [c] }, input.chains[1]!] });
    expect(run({ ...cp, chainDigest: control[0]!.chainDigest! }).break).toMatchObject({ kind: "checkpoint-unsigned" });
    expect(run({ ...cp, throughSeq: 3 }).break).toMatchObject({ kind: "checkpoint-unsigned" });
    expect(run({ ...cp, scope: "workspace:w1" }).break).toMatchObject({ kind: "checkpoint-unsigned" });
    expect(run(checkpoint(other, CONTROL_SCOPE, control, 4)).break).toMatchObject({ kind: "checkpoint-unknown-key" });
    expect(run(checkpoint(other, CONTROL_SCOPE, control, 4), [asKey(key1), asKey(other)]).break).toBeUndefined();
  });

  it("follows a key rotation: old checkpoints stay verifiable and the hand-over is checked", () => {
    const key2 = newKey();
    const control = chain(CONTROL_SCOPE, [keyEvent(key1), { payload: { n: 1 } }, { payload: { n: 2 } }, keyEvent(key2, key1), { payload: { n: 3 } }, { payload: { n: 4 } }]);
    const input: AuditExportInput = { organizationId: ORG, keys: [asKey(key1), asKey(key2)], chains: [{ scope: CONTROL_SCOPE, events: control, checkpoints: [checkpoint(key1, CONTROL_SCOPE, control, 3, "rotation"), checkpoint(key2, CONTROL_SCOPE, control, 6)] }] };
    expect(verifyAuditExport(input)).toMatchObject({ ok: true, checkpointsVerified: 2, keysPinned: false });
    // Pinned on the first key alone, the second is believed only through the signed hand-over.
    expect(verifyAuditExport(input, { trustedKeys: [asKey(key1)] })).toMatchObject({ ok: true, keysPinned: true, checkpointsVerified: 2 });
    // A pin that matches no key in the export believes none of its checkpoints.
    expect(verifyAuditExport(input, { trustedKeys: [asKey(newKey())] }).break).toMatchObject({ kind: "checkpoint-unknown-key" });
    // A key swapped for the attacker's own in the export is not the key the log recorded under that id.
    const mallory = newKey();
    expect(verifyAuditExport({ ...input, keys: [asKey(key1), { ...asKey(key2), publicKey: mallory.publicKey }] }).break).toMatchObject({ kind: "key-mismatch" });
    expect(verifyAuditExport({ ...input, keys: [asKey(key1), { ...asKey(mallory), keyId: key2.keyId }] }).break).toMatchObject({ kind: "key-mismatch" });
    // A rotation record that the previous key did not sign.
    const forged = chain(CONTROL_SCOPE, [keyEvent(key1), { type: KEY_RECORDED_EVENT, payload: { ...keyEvent(key2, key1).payload, rotationSignature: Buffer.from("not a signature").toString("base64") } }]);
    expect(verifyAuditExport({ organizationId: ORG, keys: [asKey(key1), asKey(key2)], chains: [{ scope: CONTROL_SCOPE, events: forged, checkpoints: [] }] }).break).toMatchObject({ kind: "key-unrecorded-rotation" });
  });

  it("runs plug-in checks on events whose position is sound, and reports the first failure", () => {
    const { input } = good();
    const seen: number[] = [];
    const checks = [{ name: "receipts", check: (e: AuditEventRecord) => { seen.push(e.chainSeq!); return e.chainSeq === 3 ? "receipt does not match its run" : undefined; } }];
    const r = verifyAuditExport(input, { eventChecks: checks });
    expect(r.break).toMatchObject({ kind: "event-check", chainSeq: 3, detail: "receipts: receipt does not match its run" });
    expect(seen).toEqual([1, 2, 3, 1, 2, 3]); // each log is walked to its own first problem
  });

  it("warns, without failing, about a key the log never recorded", () => {
    const control = chain(CONTROL_SCOPE, [{ payload: { n: 1 } }]);
    const r = verifyAuditExport({ organizationId: ORG, keys: [asKey(key1)], chains: [{ scope: CONTROL_SCOPE, events: control, checkpoints: [checkpoint(key1, CONTROL_SCOPE, control, 1)] }] });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringContaining(key1.keyId)]);
  });

  it("binds a chain to its organization and log: a chain cannot be moved under another scope", () => {
    const { ws, input } = good();
    const moved = { ...input, chains: [...input.chains.slice(0, 1), { scope: "workspace:w2", events: ws, checkpoints: [] }] };
    expect(verifyAuditExport(moved).break).toMatchObject({ kind: "broken-link", chain: "workspace:w2", chainSeq: 1 });
  });
});
