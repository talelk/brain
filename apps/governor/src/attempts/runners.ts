import {
  BrainError, hmacSha256Hex, RUNNER_ENROLLED_EVENT, RUNNER_REMOVED_EVENT, RUNNER_ROUTES, type Actor, type ChallengeResponse, type EnrollResponse, type HeartbeatResponse, type HelloResponse, type Runner,
} from "@brain/contracts";
import type { Context } from "hono";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { readJson, type Governor } from "../app";
import { tx, type Db } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { newId } from "../tasks/store";
import { releaseAttempt } from "./routes";

/**
 * The runner registry (docs/architecture.md section 6): enrolment with a one-use token and a public key, a challenge the runner signs to
 * get a session, and heartbeats that report what it can run. Only a keyed digest of a token is ever stored.
 */
const ENROLL_FOR_MS = 15 * 60_000;
const SESSION_FOR_MS = 12 * 3600_000;
const HEARTBEAT_MS = 10_000;
/** A runner that missed several heartbeats is not online. */
const ONLINE_FOR_MS = 45_000;

const digestOf = (gov: Gov, kind: "enroll" | "session", token: string): string => hmacSha256Hex(gov.keys.digests, Buffer.from(`runner-${kind}\n${token}`));
const names = z.array(z.string().min(1).max(100)).max(100);
const state = { capabilities: names, engines: names, slots: z.int().min(0).max(1000), freeSlots: z.int().min(0).max(1000), version: z.string().max(100) };

/** Reads a route's JSON body against its schema. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new BrainError("INVALID_INPUT", "The request is not valid", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  return parsed.data;
}

/** The runner a request's session token belongs to. */
export function runnerOf(gov: Gov, c: Context): string {
  const token = /^Bearer (.+)$/u.exec(c.req.header("authorization") ?? "")?.[1];
  const row = token === undefined ? undefined : gov.db.prepare(`SELECT k.runner_id AS id FROM runner_tokens k JOIN runners r ON r.id = k.runner_id
    WHERE k.token_digest=? AND k.kind='session' AND k.expires_at_ms>? AND r.state='active'`).get(digestOf(gov, "session", token), gov.clock.nowMs()) as { id: string } | undefined;
  if (!row) throw new BrainError("UNAUTHENTICATED", "The runner's session is not valid; say hello again");
  return row.id;
}

interface RunnerRow { id: string; name: string; state: string; capabilities_json: string; engines_json: string; slots: number; free_slots: number; version: string; last_seen_at_ms: number | null }
export function listRunners(gov: Pick<Gov, "db" | "clock">): Runner[] {
  const now = gov.clock.nowMs();
  return (gov.db.prepare("SELECT * FROM runners WHERE state='active' ORDER BY name, id").all() as RunnerRow[]).map((row) => ({
    id: row.id, name: row.name, online: row.last_seen_at_ms !== null && now - row.last_seen_at_ms < ONLINE_FOR_MS, capabilities: JSON.parse(row.capabilities_json) as string[],
    engines: JSON.parse(row.engines_json) as string[], slots: row.slots, freeSlots: row.free_slots, version: row.version, lastSeenAt: row.last_seen_at_ms,
  }));
}

function report(db: Db, runnerId: string, now: number, reported: { capabilities: string[]; engines: string[]; slots: number; freeSlots: number; version: string }): void {
  db.prepare("UPDATE runners SET capabilities_json=?, engines_json=?, slots=?, free_slots=?, version=?, last_seen_at_ms=? WHERE id=?")
    .run(JSON.stringify(reported.capabilities), JSON.stringify(reported.engines), reported.slots, reported.freeSlots, reported.version, now, runnerId);
}

/** A new one-use enrolment token; only its keyed digest is kept. */
function issueToken(gov: Gov, name: string | null, actor: Actor): { token: string; expiresAt: number } {
  const now = gov.clock.nowMs();
  const token = `brt_${randomBytes(32).toString("base64url")}`;
  const expiresAt = now + ENROLL_FOR_MS;
  gov.db.prepare("INSERT INTO runner_tokens(token_digest, kind, name, created_by, created_at_ms, expires_at_ms) VALUES (?, 'enroll', ?, ?, ?, ?)").run(digestOf(gov, "enroll", token), name, actor.id, now, expiresAt);
  append(gov.db, { type: "runner.tokenIssued", subject: "runner:new", payload: { name, expiresAt }, actor });
  return { token, expiresAt };
}

/**
 * Enrolment without a person, for the runner that is started beside the Governor on one machine: while no runner is enrolled, a one-use
 * token is written to `path`, which only the Governor's own user can read. Whoever can read the data directory could do as much.
 */
export function offerLocalRunnerToken(gov: Gov, path: string): void {
  if (gov.db.prepare("SELECT 1 FROM runners WHERE state='active'").get()) return;
  const { token } = tx(gov.db, () => issueToken(gov, "local", SYSTEM));
  rmSync(path, { force: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
}

export function registerRunners({ gov, app }: Governor): void {
  const { db, registry } = gov;

  // The token is shown once: a repeated command is refused instead of answered from a stored copy.
  registry.command("runner.token", { secretOutput: true, run: (ctx, input) => issueToken(gov, input.name ?? null, ctx.actor) });
  registry.command("runner.remove", (ctx, input) => {
    if (db.prepare("UPDATE runners SET state='removed', removed_at_ms=? WHERE id=? AND state='active'").run(ctx.now(), input.runnerId).changes === 0) throw new BrainError("NOT_FOUND", "Runner not found");
    db.prepare("DELETE FROM runner_tokens WHERE runner_id=? AND kind='session'").run(input.runnerId);
    append(db, { type: RUNNER_REMOVED_EVENT, subject: `runner:${input.runnerId}`, payload: { runnerId: input.runnerId }, actor: ctx.actor });
    // What it was running goes back to the queue for another runner.
    for (const { id } of db.prepare("SELECT id FROM attempts WHERE runner_id=? AND state IN ('offered','running')").all(input.runnerId) as Array<{ id: string }>) releaseAttempt(gov, id, "Its runner was removed");
    return {};
  });
  registry.query("runners.list", () => ({ runners: listRunners(gov) }));

  app.post(RUNNER_ROUTES.enroll, async (c) => {
    const input = await body(c, z.strictObject({ token: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), publicKeyPem: z.string().min(1).max(2000) }));
    let ed25519 = false;
    try { ed25519 = createPublicKey(input.publicKeyPem).asymmetricKeyType === "ed25519"; } catch { /* not a key */ }
    if (!ed25519) throw new BrainError("INVALID_INPUT", "The runner's public key must be an ed25519 key in PEM");
    return c.json(tx(db, (): EnrollResponse => {
      const now = gov.clock.nowMs();
      const used = db.prepare("UPDATE runner_tokens SET used_at_ms=? WHERE token_digest=? AND kind='enroll' AND used_at_ms IS NULL AND expires_at_ms>?").run(now, digestOf(gov, "enroll", input.token), now);
      if (used.changes === 0) throw new BrainError("FORBIDDEN", "The enrolment token is wrong, used or expired");
      const runnerId = newId("r");
      db.prepare("INSERT INTO runners(id, name, public_key_pem, created_at_ms) VALUES (?,?,?,?)").run(runnerId, input.name, input.publicKeyPem, now);
      db.prepare("UPDATE runner_tokens SET runner_id=? WHERE token_digest=?").run(runnerId, digestOf(gov, "enroll", input.token));
      append(db, { type: RUNNER_ENROLLED_EVENT, subject: `runner:${runnerId}`, payload: { runnerId, name: input.name, publicKeyPem: input.publicKeyPem }, actor: { kind: "runner", id: runnerId } });
      return { runnerId };
    }));
  });

  app.post(RUNNER_ROUTES.challenge, async (c) => {
    const input = await body(c, z.strictObject({ runnerId: z.string().min(1).max(100) }));
    if (!db.prepare("SELECT 1 FROM runners WHERE id=? AND state='active'").get(input.runnerId)) throw new BrainError("UNAUTHENTICATED", "This runner is not enrolled");
    const answer: ChallengeResponse = { challengeId: newId("ch"), nonce: randomBytes(32).toString("base64url"), expiresAt: gov.clock.nowMs() + 60_000 };
    db.prepare("DELETE FROM runner_challenges WHERE expires_at_ms<=?").run(gov.clock.nowMs());
    db.prepare("INSERT INTO runner_challenges(id, runner_id, nonce, expires_at_ms) VALUES (?,?,?,?)").run(answer.challengeId, input.runnerId, answer.nonce, answer.expiresAt);
    return c.json(answer);
  });

  app.post(RUNNER_ROUTES.hello, async (c) => {
    const input = await body(c, z.strictObject({ ...state, runnerId: z.string().min(1).max(100), challengeId: z.string().min(1).max(100), signature: z.string().min(1).max(500) }));
    return c.json(tx(db, (): HelloResponse => {
      const now = gov.clock.nowMs();
      const row = db.prepare(`SELECT c.nonce, r.public_key_pem AS key FROM runner_challenges c JOIN runners r ON r.id = c.runner_id
        WHERE c.id=? AND c.runner_id=? AND c.used_at_ms IS NULL AND c.expires_at_ms>? AND r.state='active'`).get(input.challengeId, input.runnerId, now) as { nonce: string; key: string } | undefined;
      let proven = false;
      try { proven = row !== undefined && verify(null, Buffer.from(row.nonce), row.key, Buffer.from(input.signature, "base64url")); } catch { /* not a signature */ }
      if (!proven) throw new BrainError("UNAUTHENTICATED", "The challenge was not answered with the runner's key");
      db.prepare("UPDATE runner_challenges SET used_at_ms=? WHERE id=?").run(now, input.challengeId);
      report(db, input.runnerId, now, input);
      const sessionToken = `brs_${randomBytes(32).toString("base64url")}`;
      db.prepare("DELETE FROM runner_tokens WHERE runner_id=? AND kind='session'").run(input.runnerId);
      db.prepare("INSERT INTO runner_tokens(token_digest, kind, runner_id, created_at_ms, expires_at_ms) VALUES (?, 'session', ?, ?, ?)").run(digestOf(gov, "session", sessionToken), input.runnerId, now, now + SESSION_FOR_MS);
      return { sessionToken, expiresAt: now + SESSION_FOR_MS, heartbeatMs: HEARTBEAT_MS };
    }));
  });

  app.post(RUNNER_ROUTES.heartbeat, async (c) => {
    const runnerId = runnerOf(gov, c);
    const input = await body(c, z.strictObject({ ...state, running: z.array(z.string().max(100)).max(1000) }));
    report(db, runnerId, gov.clock.nowMs(), input);
    // Anything the runner still runs that is no longer its own to run: the task was stopped, or the lease moved.
    const mine = new Set((db.prepare("SELECT id FROM attempts WHERE runner_id=? AND state IN ('offered','running')").all(runnerId) as Array<{ id: string }>).map((row) => row.id));
    return c.json({ stop: input.running.filter((id) => !mine.has(id)) } satisfies HeartbeatResponse);
  });
}
