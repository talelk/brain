import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_MATRIX, CONTROL_SCOPE, auditChainDigest, auditGenesis, auditKeyId, domainDigest, workspaceScope, type AuditExportPage, type AuditKey } from "@brain/contracts";
import { actingAs, systemActor } from "../../apps/governor/src/application/actor-context";
import { advance, closeWorlds, run, startedMission, type World } from "../support/machine-session";

// Tamper-evident audit (ADR 0078, #152), at the Governor seam. State is built through commands and the Governor's own passes; the
// SQL statements below are the ATTACK under test (someone with write access to the data files), never test arrangement.

afterEach(closeWorlds);

const wsDb = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const ws = (w: World) => workspaceScope(w.workspaceId);
const verify = (w: World, options?: Parameters<World["brain"]["audit"]["verifyNow"]>[1]) => w.brain.audit.verifyNow(w.org, options);
/** A busy world: a mission with a started attempt, comments and a pause, so both logs hold many events of many kinds. */
async function busy() {
  const world = await startedMission();
  for (let i = 0; i < 4; i++) await run(world.w, "workItem.comment", `c${i}`, { workItemId: world.workItemId, text: `note ${i}` });
  return world;
}
const rowsOf = (db: ReturnType<typeof wsDb>) => db.prepare("SELECT cursor, chain_seq FROM events ORDER BY cursor").all() as Array<{ cursor: number; chain_seq: number }>;

describe("the event hash chain", () => {
  it("chains every event of every log, and an untouched busy world verifies", async () => {
    const { w } = await busy();
    const control = w.brain.store.control.prepare("SELECT COUNT(*) AS n, COUNT(chain_seq) AS chained FROM events").get() as { n: number; chained: number };
    const inside = wsDb(w).prepare("SELECT COUNT(*) AS n, COUNT(chain_seq) AS chained FROM events").get() as { n: number; chained: number };
    expect(control.n).toBeGreaterThanOrEqual(5); expect(inside.n).toBeGreaterThan(5);
    expect(control.chained).toBe(control.n); expect(inside.chained).toBe(inside.n);
    const result = verify(w);
    expect(result).toMatchObject({ ok: true, verifiedEvents: control.n + inside.n, keysPinned: false });
    expect(result.chains.map((c) => c.scope).sort()).toEqual([CONTROL_SCOPE, ws(w)].sort());
    // Positions are dense and the first event continues from the genesis bound to its log.
    expect(rowsOf(wsDb(w)).map((r) => r.chain_seq)).toEqual(Array.from({ length: inside.n }, (_, i) => i + 1));
    expect(wsDb(w).prepare("SELECT prev_digest FROM events ORDER BY cursor LIMIT 1").get()).toEqual({ prev_digest: auditGenesis(w.org, ws(w)) });
  });

  it("every stored payload survives the round trip its digest was taken from", async () => {
    const { w } = await busy();
    for (const db of [w.brain.store.control, wsDb(w)]) {
      for (const row of db.prepare("SELECT event_id, payload_json, payload_digest FROM events").all() as Array<{ event_id: string; payload_json: string; payload_digest: string }>) {
        expect(domainDigest("brain:event:v1", JSON.parse(row.payload_json)), row.event_id).toBe(row.payload_digest);
      }
    }
  });

  it("detects an edited payload, wherever it is, and says which event", async () => {
    const { w } = await busy();
    const row = wsDb(w).prepare("SELECT event_id, chain_seq FROM events WHERE chain_seq=4").get() as { event_id: string; chain_seq: number };
    wsDb(w).prepare("UPDATE events SET payload_json=json_set(payload_json,'$.tampered',1) WHERE event_id=?").run(row.event_id);
    expect(verify(w).break).toMatchObject({ kind: "payload-edited", chain: ws(w), chainSeq: 4, eventId: row.event_id });
  });

  it("detects an edited actor, even when the payload digest is rewritten to match", async () => {
    const { w } = await busy();
    const control = w.brain.store.control;
    const row = control.prepare("SELECT event_id, chain_seq FROM events WHERE actor_kind='human' ORDER BY cursor LIMIT 1").get() as { event_id: string; chain_seq: number };
    control.prepare("UPDATE events SET actor_id='someone-else' WHERE event_id=?").run(row.event_id);
    expect(verify(w).break).toMatchObject({ kind: "event-edited", chain: CONTROL_SCOPE, chainSeq: row.chain_seq, eventId: row.event_id });
  });

  it("detects a removed event at the position after it", async () => {
    const { w } = await busy();
    const victim = wsDb(w).prepare("SELECT event_id FROM events WHERE chain_seq=5").get() as { event_id: string };
    wsDb(w).prepare("DELETE FROM outbox_deliveries WHERE event_id=?").run(victim.event_id);
    wsDb(w).prepare("DELETE FROM events WHERE event_id=?").run(victim.event_id);
    expect(verify(w).break).toMatchObject({ kind: "sequence-gap", chain: ws(w), chainSeq: 6 });
  });

  it("detects reordered events", async () => {
    const { w } = await busy();
    const db = wsDb(w);
    db.transaction(() => { // swap the positions of two events (through a free value, because positions are unique)
      db.prepare("UPDATE events SET chain_seq=-1 WHERE chain_seq=3").run();
      db.prepare("UPDATE events SET chain_seq=3 WHERE chain_seq=4").run();
      db.prepare("UPDATE events SET chain_seq=4 WHERE chain_seq=-1").run();
    })();
    expect(verify(w).break).toMatchObject({ kind: "sequence-gap", chain: ws(w), chainSeq: 4 });
  });

  it("detects an event added outside the audit log", async () => {
    const { w } = await busy();
    wsDb(w).prepare("INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES ('evt-forged','x','x',1,'x.y','{}',?,?)")
      .run(domainDigest("brain:event:v1", {}), Date.now());
    expect(verify(w).break).toMatchObject({ kind: "unchained-event", eventId: "evt-forged" });
  });

  it("detects a tail cut after a signed checkpoint, but not a cut the checkpoints never saw", async () => {
    const { w } = await busy();
    const head = (wsDb(w).prepare("SELECT MAX(chain_seq) AS m FROM events").get() as { m: number }).m;
    const cut = (db: ReturnType<typeof wsDb>, from: number) => {
      const ids = (db.prepare("SELECT event_id FROM events WHERE chain_seq>=?").all(from) as Array<{ event_id: string }>).map((r) => r.event_id);
      for (const id of ids) { db.prepare("DELETE FROM outbox_deliveries WHERE event_id=?").run(id); db.prepare("DELETE FROM events WHERE event_id=?").run(id); }
    };
    // Cut before any checkpoint exists: the chain stays valid, and the limit is real (ADR 0078 says so).
    cut(wsDb(w), head - 1);
    expect(verify(w).ok).toBe(true);
    // Another busy stretch, a checkpoint, then the newest events are cut away.
    await run(w, "workItem.comment", "after-cut-1", { workItemId: (wsDb(w).prepare("SELECT id FROM work_items LIMIT 1").get() as { id: string }).id, text: "again" });
    const checkpoints = w.brain.audit.checkpointNow(w.owner);
    expect(checkpoints.map((c) => c.scope).sort()).toEqual([CONTROL_SCOPE, ws(w)].sort());
    expect(verify(w).ok).toBe(true);
    const signedAt = checkpoints.find((c) => c.scope === ws(w))!.throughSeq;
    cut(wsDb(w), signedAt - 1);
    expect(verify(w).break).toMatchObject({ kind: "tail-truncated", chain: ws(w), chainSeq: signedAt });
  });

  it("detects a log rebuilt after an edit, because the signed checkpoint remembers the old history", async () => {
    const { w } = await busy();
    w.brain.audit.checkpointNow(w.owner);
    const db = wsDb(w);
    // The attacker edits one event and recomputes the digests of every event after it, with the same functions the Governor uses.
    db.transaction(() => {
      db.prepare("UPDATE events SET payload_json=json_set(payload_json,'$.rewritten',1) WHERE chain_seq=3").run();
      let prev = (db.prepare("SELECT chain_digest AS d FROM events WHERE chain_seq=2").get() as { d: string }).d;
      for (const e of db.prepare("SELECT * FROM events WHERE chain_seq>=3 ORDER BY chain_seq").all() as Array<Record<string, unknown>>) {
        const payloadDigest = domainDigest("brain:event:v1", JSON.parse(e["payload_json"] as string));
        const digest = auditChainDigest(prev as never, e["chain_seq"] as number, { eventId: e["event_id"] as string, organizationId: null, workspaceId: null, aggregateType: e["aggregate_type"] as string, aggregateId: e["aggregate_id"] as string, aggregateSeq: e["aggregate_seq"] as number, eventType: e["event_type"] as string, payloadDigest, createdAtMs: e["created_at_ms"] as number, actorId: e["actor_id"] as string, actorKind: e["actor_kind"] as string, actorAttemptId: e["actor_attempt_id"] as string | null, actingFor: e["acting_for"] as string | null });
        db.prepare("UPDATE events SET prev_digest=?, payload_digest=?, chain_digest=? WHERE event_id=?").run(prev, payloadDigest, digest, e["event_id"]);
        prev = digest;
      }
    })();
    expect(verify(w).break).toMatchObject({ kind: "checkpoint-mismatch", chain: ws(w) });
  });
});

describe("signed checkpoints and the audit key", () => {
  it("a checkpoint names the position and head digest and is signed by the Governor's key, which has an owner-only file", async () => {
    const { w } = await busy();
    const [control, inside] = [w.brain.audit.checkpointNow(w.owner).find((c) => c.scope === CONTROL_SCOPE)!, w.brain.audit.checkpointNow(w.owner).find((c) => c.scope === ws(w))!];
    const overview = w.brain.audit.overview(w.owner);
    expect(overview.keys).toHaveLength(1);
    expect(control.keyId).toBe(overview.activeKeyId);
    expect(auditKeyId(overview.keys[0]!.publicKey)).toBe(overview.activeKeyId);
    const head = w.brain.store.control.prepare("SELECT chain_seq, chain_digest FROM events WHERE organization_id=? ORDER BY chain_seq DESC LIMIT 1").get(w.org) as { chain_seq: number; chain_digest: string };
    expect(control).toMatchObject({ throughSeq: head.chain_seq, chainDigest: head.chain_digest, reason: "demand", organizationId: w.org });
    expect(inside.scope).toBe(ws(w));
    const keyFile = join(w.dir, "audit", `${overview.activeKeyId}.key`);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(w.dir, "audit"))).toEqual([`${overview.activeKeyId}.key`]);
    // Asking again with nothing new writes nothing new.
    expect(w.brain.audit.checkpointNow(w.owner).map((c) => c.checkpointId).sort()).toEqual([control.checkpointId, inside.checkpointId].sort());
    expect(verify(w)).toMatchObject({ ok: true, checkpointsVerified: 2 });
  });

  it("a forged checkpoint is found: a changed digest, a changed position, another key's signature", async () => {
    const { w } = await busy();
    w.brain.audit.checkpointNow(w.owner);
    const row = () => w.brain.store.control.prepare("SELECT * FROM audit_checkpoints WHERE scope=?").get(ws(w)) as { id: string; chain_digest: string; through_seq: number; signature: string };
    const original = row();
    w.brain.store.control.prepare("UPDATE audit_checkpoints SET through_seq=through_seq-1 WHERE id=?").run(original.id);
    expect(verify(w).break).toMatchObject({ kind: "checkpoint-unsigned", chain: ws(w) });
    w.brain.store.control.prepare("UPDATE audit_checkpoints SET through_seq=?, signature=? WHERE id=?").run(original.through_seq, Buffer.alloc(64, 7).toString("base64"), original.id);
    expect(verify(w).break).toMatchObject({ kind: "checkpoint-unsigned" });
    w.brain.store.control.prepare("UPDATE audit_checkpoints SET signature=? WHERE id=?").run(original.signature, original.id);
    expect(verify(w).ok).toBe(true);
  });

  it("rotation retires the key, hands over with a signature recorded in the chain, and old checkpoints stay verifiable", async () => {
    const { w } = await busy();
    const first = w.brain.audit.overview(w.owner).activeKeyId;
    w.brain.audit.checkpointNow(w.owner);
    advance(1000);
    await run(w, "workItem.comment", "between-keys", { workItemId: (wsDb(w).prepare("SELECT id FROM work_items LIMIT 1").get() as { id: string }).id, text: "between keys" });
    const rotated = w.brain.audit.rotateKey(w.owner);
    expect(rotated.retiredKeyId).toBe(first);
    expect(rotated.activeKeyId).not.toBe(first);
    expect(rotated.keys.map((k: AuditKey) => [k.keyId, k.retiredAtMs !== null])).toEqual([[first, true], [rotated.activeKeyId, false]]);
    expect(readdirSync(join(w.dir, "audit"))).toEqual([`${rotated.activeKeyId}.key`]);
    // The rotation is in the chain, attributed to the person who did it, and the new key signs from now on.
    const recorded = w.brain.store.control.prepare("SELECT actor_id, json_extract(payload_json,'$.keyId') AS keyId, json_extract(payload_json,'$.previousKeyId') AS previous FROM events WHERE event_type='audit.keyRecorded' ORDER BY cursor").all();
    expect(recorded).toEqual([{ actor_id: "system:audit", keyId: first, previous: null }, { actor_id: w.owner.actorId, keyId: rotated.activeKeyId, previous: first }]);
    w.brain.audit.checkpointNow(w.owner);
    const keysUsed = new Set((w.brain.store.control.prepare("SELECT key_id FROM audit_checkpoints").all() as Array<{ key_id: string }>).map((r) => r.key_id));
    expect([...keysUsed].sort()).toEqual([first, rotated.activeKeyId].sort());
    expect(verify(w)).toMatchObject({ ok: true, keysPinned: false });
    const pinnedFirst = w.brain.audit.keys.list().filter((k) => k.keyId === first);
    expect(verify(w, { trustedKeys: pinnedFirst })).toMatchObject({ ok: true, keysPinned: true });
    // The public key row replaced with the attacker's own is not the key the chain recorded.
    w.brain.store.control.prepare("UPDATE audit_keys SET public_key=(SELECT public_key FROM audit_keys WHERE key_id=?) WHERE key_id=?").run(first, rotated.activeKeyId);
    expect(verify(w).break).toMatchObject({ kind: "key-mismatch" });
  });

  it("only an organization administrator exports, checkpoints or rotates; any signed-in person reads the public keys", async () => {
    const { w } = await busy();
    const member = w.actor("someone-without-admin", w.workspaceId);
    expect(() => w.brain.audit.exportPage(member, { scope: CONTROL_SCOPE, afterCursor: 0, limit: 10 })).toThrow(/administration/u);
    expect(() => w.brain.audit.checkpointNow(member)).toThrow(/administration/u);
    expect(() => w.brain.audit.rotateKey(member)).toThrow(/administration/u);
    expect(w.brain.audit.overview(member).keys).toHaveLength(1);
    expect(() => w.brain.audit.exportPage(w.owner, { scope: "workspace:not-mine", afterCursor: 0, limit: 10 })).toThrow(/not found/u);
  });

  it("the export is paged in written order and a verifier that only has the pages reaches the same verdict", async () => {
    const { w } = await busy();
    w.brain.audit.checkpointNow(w.owner);
    const pages: AuditExportPage[] = []; let after = 0;
    for (;;) {
      const page = w.brain.audit.exportPage(w.owner, { scope: ws(w), afterCursor: after, limit: 3 });
      pages.push(page);
      if (page.nextAfterCursor === null) break;
      after = page.nextAfterCursor;
    }
    expect(pages.length).toBeGreaterThan(2);
    const events = pages.flatMap((p) => p.events);
    expect(events.map((e) => e.chainSeq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    expect(pages[0]!.headSeq).toBe(events.length);
    expect(pages[0]!.keys).toEqual(w.brain.audit.keys.list());
  });
});

describe("who may use the audit endpoints is what the authorization matrix says", () => {
  it("each audit endpoint needs exactly the caller kind and scopes its matrix entry lists, and none is open to an agent", async () => {
    const { w } = await busy();
    const call: Record<string, (actor: typeof w.owner) => unknown> = {
      "audit.overview": (actor) => w.brain.audit.overview(actor),
      "audit.export": (actor) => w.brain.audit.exportPage(actor, { scope: CONTROL_SCOPE, afterCursor: 0, limit: 10 }),
      "audit.checkpoint": (actor) => w.brain.audit.checkpointNow(actor),
      "audit.rotate-key": (actor) => w.brain.audit.rotateKey(actor),
    };
    for (const endpoint of ["audit.overview", "audit.export", "audit.checkpoint"]) {
      const policy = AUTH_MATRIX.specialEndpoints[endpoint]!;
      const needed = [policy.scope, ...(policy.additionalScopes ?? [])].filter((scope) => !scope.startsWith("none:"));
      expect(w.owner.scopes, endpoint).toEqual(expect.arrayContaining(needed));
      expect(() => call[endpoint]!(w.owner), endpoint).not.toThrow();
      // Taking away any one scope the matrix lists, or being an agent instead of a person, is refused.
      for (const scope of needed) {
        expect(() => call[endpoint]!({ ...w.owner, scopes: w.owner.scopes.filter((held) => held !== scope) }), `${endpoint} without ${scope}`).toThrow(/FORBIDDEN|audit log/u);
      }
      expect(() => call[endpoint]!({ ...w.owner, kind: "agent" }), `${endpoint} as an agent`).toThrow(/signed-in person/u);
    }
    const rotate = AUTH_MATRIX.specialEndpoints["audit.rotate-key"]!;
    for (const scope of [rotate.scope, ...(rotate.additionalScopes ?? [])]) expect(() => call["audit.rotate-key"]!({ ...w.owner, scopes: w.owner.scopes.filter((held) => held !== scope) })).toThrow(/organization administration/u);
    expect(() => call["audit.rotate-key"]!({ ...w.owner, kind: "agent" })).toThrow(/signed-in person/u);
  });
});

describe("self-verification and Health", () => {
  it("a pass records the keys, writes due checkpoints and reports the chain on Health; a break turns it unavailable and alerts the owner once", async () => {
    const { w } = await busy();
    actingAs(systemActor("test"), () => undefined);
    w.brain.audit.pass();
    const probe = () => w.brain.store.control.prepare("SELECT status, detail FROM service_probes WHERE id='audit'").get() as { status: string; detail: string };
    expect(probe()).toMatchObject({ status: "healthy", detail: expect.stringMatching(/^Audit log verified: \d+ events in 2 logs\. Last checkpoint just now\.$/u) });
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM audit_checkpoints").get()).toEqual({ n: 2 });
    expect(w.brain.store.control.prepare("SELECT actor_id FROM events WHERE event_type='audit.keyRecorded'").all()).toEqual([{ actor_id: "system:audit" }]);
    // Nothing new: another pass writes nothing more.
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM audit_checkpoints").get()).toEqual({ n: 2 });

    // New events are picked up by the next pass without walking the log again.
    await run(w, "workItem.comment", "late", { workItemId: (wsDb(w).prepare("SELECT id FROM work_items LIMIT 1").get() as { id: string }).id, text: "late" });
    advance(16 * 60_000);
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM audit_checkpoints WHERE scope=?").get(ws(w))).toEqual({ n: 2 });

    // An old event the scan already passed is found by the next full walk, an hour on by default.
    const old = wsDb(w).prepare("SELECT event_id FROM events WHERE chain_seq=2").get() as { event_id: string };
    wsDb(w).prepare("UPDATE events SET actor_id='intruder-1' WHERE event_id=?").run(old.event_id);
    w.brain.audit.pass();
    expect(probe().status).toBe("healthy");
    advance(61 * 60_000);
    w.brain.audit.pass();
    expect(probe()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("event 2") });
    // A finding stays reported: more passes do not clear it.
    w.brain.audit.pass();
    expect(probe().status).toBe("unavailable");
    // No new checkpoint is signed over a log that fails verification.
    expect(() => w.brain.audit.checkpointNow(w.owner)).toThrow(/failed verification/u);
    await w.brain.runEngineProbes(async () => new Response("{}"));
    const alerts = wsDb(w).prepare("SELECT title FROM attention_notifications WHERE item_id='platform:audit'").all() as Array<{ title: string }>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toContain("The audit log needs attention");
  });

  it("an edit of one of the newest events is caught on the next pass, without waiting for a full walk", async () => {
    const { w } = await busy();
    w.brain.audit.pass();
    const last = wsDb(w).prepare("SELECT event_id FROM events ORDER BY cursor DESC LIMIT 1").get() as { event_id: string };
    wsDb(w).prepare("UPDATE events SET actor_id='intruder' WHERE event_id=?").run(last.event_id);
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT status, detail FROM service_probes WHERE id='audit'").get()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("failed verification") });
  });

  it("the live walk finds a removed tail event and a missing key file on a pass", async () => {
    const { w } = await busy();
    w.brain.audit.pass();
    const last = wsDb(w).prepare("SELECT event_id FROM events ORDER BY cursor DESC LIMIT 1").get() as { event_id: string };
    wsDb(w).prepare("DELETE FROM outbox_deliveries WHERE event_id=?").run(last.event_id);
    wsDb(w).prepare("DELETE FROM events WHERE event_id=?").run(last.event_id);
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT status, detail FROM service_probes WHERE id='audit'").get()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("removed") });
  });

  it("a missing signing key is reported on Health and refuses to sign, and rotation replaces it", async () => {
    const { w } = await busy();
    const active = w.brain.audit.overview(w.owner).activeKeyId;
    const file = join(w.dir, "audit", `${active}.key`);
    expect(existsSync(file)).toBe(true);
    (await import("node:fs")).unlinkSync(file);
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT status, detail FROM service_probes WHERE id='audit'").get()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("missing") });
    expect(() => w.brain.audit.checkpointNow(w.owner)).toThrow(/missing/u);
    const rotated = w.brain.audit.rotateKey(w.owner);
    expect(rotated.activeKeyId).not.toBe(active);
    w.brain.audit.pass();
    expect(w.brain.store.control.prepare("SELECT status FROM service_probes WHERE id='audit'").get()).toEqual({ status: "healthy" });
  });

  it("the diagnostics bundle carries the public keys and log positions, and no event content", async () => {
    const { w } = await busy();
    w.brain.audit.checkpointNow(w.owner);
    const bundle = w.brain.diagnostics(w.owner, w.workspaceId, "corr-audit");
    expect(bundle.audit.activeKeyId).toBe(w.brain.audit.overview(w.owner).activeKeyId);
    expect(bundle.audit.keys[0]!.publicKey).toBeTruthy();
    expect(bundle.audit.scopes.map((s) => s.scope).sort()).toEqual([CONTROL_SCOPE, ws(w)].sort());
    expect(JSON.stringify(bundle.audit)).not.toContain("payload");
  });
});

describe("cost", () => {
  it("recording an event stays cheap: a few thousand chained events in a moment", async () => {
    const { w } = await startedMission();
    const db = wsDb(w);
    const started = performance.now();
    actingAs(systemActor("bench"), () => { for (let i = 0; i < 3000; i++) w.brain.store.emit(db, { aggregateType: "bench", aggregateId: `b${i % 7}`, eventType: "bench.event", payload: { i } }); });
    const perEvent = (performance.now() - started) / 3000;
    expect(perEvent).toBeLessThan(5);
    expect(verify(w).ok).toBe(true);
  });
});
