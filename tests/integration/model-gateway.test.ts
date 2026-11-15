import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type TestWorld } from "../helpers";
import { command } from "../support/reuse";
import { clock, gatewayWorld, route, running, secondAttempt, set, upstream } from "../support/model-gateway";

// ADR 0066 at the Governor's boundary: a route the owner sends through the gateway is called by the runner with its attempt's gateway token; the
// Governor forwards with the key held on its own host, enforces the route list, cooldowns and the spend stop, records counts and never a body.
const worlds: TestWorld[] = [];
const dirs: string[] = [];
const world = (): TestWorld => { const w = gatewayWorld(dirs); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); for (const name of ["BRAIN_MODEL_KEY_ACME_A", "BRAIN_MODEL_KEY_ACME_B"]) delete process.env[name]; });

const SENTINEL = "SENTINEL-prompt-text-that-must-never-be-stored";
const call = (w: TestWorld, token: string | undefined, routeId: string, body: Record<string, unknown> = { model: "whatever", messages: [{ role: "user", content: SENTINEL }] }) =>
  w.brain.modelGateway.handle(new Request(`http://governor.test/model-gateway/v1/routes/${routeId}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), routeId);
const calls = (w: TestWorld) => w.brain.store.control.prepare("SELECT route_id AS routeId, model, status, outcome, input_tokens AS inputTokens, output_tokens AS outputTokens, micro_usd AS microUsd FROM model_gateway_calls ORDER BY at_ms, rowid").all() as Array<Record<string, unknown>>;
const offered = (w: TestWorld, jobId: string) => (JSON.parse((w.brain.store.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string }).payload_json) as { modelRoutes?: Array<Record<string, unknown>> }).modelRoutes ?? [];

describe("the model gateway (ADR 0066)", () => {
  it("forwards a call with the key held on the Governor, relays the answer and records counts, never what was said", async () => {
    const w = world();
    const fake = upstream({ a: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "g-1", [route("a")]);
    const job = await secondAttempt(w, "g1");
    const attempt = running(w, job.runner, "req-g1");
    // What the runner is offered names neither the upstream address nor the key reference.
    expect(offered(w, job.jobId)).toEqual([expect.objectContaining({ routeId: "a", viaGateway: true, model: "model-a" })]);
    expect(JSON.stringify(offered(w, job.jobId))).not.toMatch(/acme\.example|acme-a|REAL-KEY/u);

    const answer = await call(w, attempt.token, "a");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ choices: [{ message: { content: "OK" } }] });
    // The vendor received the Governor's key and the route's model, whatever the caller named.
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toMatchObject({ url: "https://a.acme.example/v1/chat/completions", authorization: "Bearer REAL-KEY-A-held-on-the-governor" });
    expect(fake.seen[0]!.body["model"]).toBe("model-a");
    // Usage is priced with the route's prices: 2000 x $3/M + 200 x $15/M = $0.009.
    expect(calls(w)).toEqual([{ routeId: "a", model: "model-a", status: 200, outcome: "served", inputTokens: 2000, outputTokens: 200, microUsd: 9_000 }]);
  });

  it("relays a stream as a stream and reads its token counts from the closing chunk", async () => {
    const w = world();
    const fake = upstream({ a: "stream" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "s-1", [route("a")]);
    const job = await secondAttempt(w, "s1");
    const attempt = running(w, job.runner, "req-s1");
    const answer = await call(w, attempt.token, "a", { model: "x", stream: true, messages: [{ role: "user", content: SENTINEL }] });
    expect(answer.headers.get("content-type")).toContain("text/event-stream");
    const text = await answer.text();
    expect(text).toContain("data: [DONE]");
    expect(fake.seen[0]!.body["stream_options"]).toEqual({ include_usage: true });
    expect(calls(w)).toEqual([{ routeId: "a", model: "model-a", status: 200, outcome: "served", inputTokens: 1000, outputTokens: 100, microUsd: 4_500 }]);
  });

  it("stores no request or answer anywhere in either database", async () => {
    const w = world();
    w.brain.modelFetch = upstream({ a: "ok" }).fetch;
    await set(w, "n-1", [route("a")]);
    const job = await secondAttempt(w, "n1");
    const attempt = running(w, job.runner, "req-n1");
    await (await call(w, attempt.token, "a")).text();
    w.brain.store.control.pragma?.("wal_checkpoint(TRUNCATE)");
    const files: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path); } };
    walk(dirs.at(-1)!);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) { const bytes = readFileSync(file); expect(bytes.includes(SENTINEL), file).toBe(false); expect(bytes.includes("REAL-KEY-A"), file).toBe(false); expect(bytes.includes(attempt.token), file).toBe(false); }
  });

  it("passes a provider's quota refusal through and leaves the route out of every later offer; the next route serves", async () => {
    const w = world();
    const fake = upstream({ a: "quota", b: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "q-1", [route("a"), route("b")]);
    const job = await secondAttempt(w, "q1");
    const attempt = running(w, job.runner, "req-q1");
    const refused = await call(w, attempt.token, "a");
    await refused.text();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("45");
    // The route is cooling centrally: a second call is refused without reaching the vendor.
    const again = await call(w, attempt.token, "a");
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).not.toBeNull();
    expect(fake.seen).toHaveLength(1);
    // The runner moves to the next route, which serves with its own key.
    const served = await call(w, attempt.token, "b");
    await served.text();
    expect(served.status).toBe(200);
    expect(fake.seen[1]).toMatchObject({ url: "https://b.acme.example/v1/chat/completions", authorization: "Bearer REAL-KEY-B-held-on-the-governor" });
    expect(calls(w).map((entry) => [entry["routeId"], entry["outcome"]])).toEqual([["a", "quota"], ["a", "quota"], ["b", "served"]]);
    // A later job is not offered the cooling route.
    const next = await secondAttempt(w, "q2");
    w.brain.jobProtocol.claim(next.runner, "req-q2");
    expect(offered(w, next.jobId).map((entry) => entry["routeId"])).toEqual(["b"]);
  });

  it("refuses without a token, with an unknown one, after the attempt ended and once the token expired; none of these look like quota", async () => {
    const w = world();
    const fake = upstream({ a: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "t-1", [route("a")]);
    const job = await secondAttempt(w, "t1");
    const attempt = running(w, job.runner, "req-t1");
    for (const token of [undefined, "bgw_not-a-token"]) {
      const res = await call(w, token, "a");
      expect(res.status).toBe(401);
    }
    expect((await call(w, attempt.token, "a")).status).toBe(200);
    // Asking again replaces the token: the earlier one is refused at once.
    const replaced = w.brain.jobProtocol.modelGatewayToken(job.runner, attempt.attemptId).token;
    const old = await call(w, attempt.token, "a");
    expect(old.status).toBe(401);
    expect(await old.text()).not.toMatch(/quota|rate limit|429/iu);
    expect((await call(w, replaced, "a")).status).toBe(200);
    // The attempt ends: its token is revoked.
    w.brain.jobProtocol.complete(job.runner, attempt.attemptId, { result: "succeeded", jobFence: attempt.jobFence, cleanupConfirmed: true, output: { ok: true } });
    const ended = await call(w, replaced, "a");
    expect(ended.status).toBe(401);
    expect(fake.seen).toHaveLength(2);
    expect((w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM model_gateway_tokens WHERE revoked_at_ms IS NULL").get() as { n: number }).n).toBe(0);
  });

  it("refuses a token whose time ran out and one whose attempt lost its lease", async () => {
    const w = world();
    const fake = upstream({ a: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "x-1", [route("a")]);
    const job = await secondAttempt(w, "x1");
    const attempt = running(w, job.runner, "req-x1");
    // Past the lease the runner stopped renewing, the attempt is no longer running under its fence.
    clock.now += 10 * 60_000;
    const res = await call(w, attempt.token, "a");
    expect(res.status).toBe(401);
    expect(fake.seen).toHaveLength(0);
  });

  it("refuses a route the attempt was not offered, one that does not go through the gateway, and an oversize request", async () => {
    const w = world();
    const fake = upstream({ a: "ok", b: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "r-1", [route("a"), route("b", { viaGateway: false })]);
    const job = await secondAttempt(w, "r1");
    const attempt = running(w, job.runner, "req-r1");
    // The direct route is offered as before, with its key reference and address; the gateway one is not.
    expect(offered(w, job.jobId)).toEqual([expect.objectContaining({ routeId: "a", viaGateway: true }), expect.objectContaining({ routeId: "b", keyRef: "acme-b", baseUrl: "https://b.acme.example/v1" })]);
    expect((await call(w, attempt.token, "b")).status).toBe(403);
    expect((await call(w, attempt.token, "nowhere")).status).toBe(403);
    const huge = await call(w, attempt.token, "a", { model: "x", messages: [{ role: "user", content: "x".repeat(5 * 1024 * 1024) }] });
    expect(huge.status).toBe(413);
    expect(fake.seen).toHaveLength(0);
  });

  it("asks nothing of the gateway when no route goes through it", async () => {
    const w = world();
    await set(w, "d-1", [route("b", { viaGateway: false })]);
    const job = await secondAttempt(w, "d1");
    const offer = w.brain.jobProtocol.claim(job.runner, "req-d1") as unknown as { attemptId: string; leaseId: string; jobFence: number };
    w.brain.jobProtocol.ack(job.runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    expect(() => w.brain.jobProtocol.modelGatewayToken(job.runner, offer.attemptId)).toThrow(/gateway/u);
  });

  it("stops at the mission's money and at the workspace cap, and serves an attempt that is under both", async () => {
    const w = world();
    const fake = upstream({ a: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "b-1", [route("a")]);
    const job = await secondAttempt(w, "b1");
    const attempt = running(w, job.runner, "req-b1");
    // Positive control: under budget and cap the call is served.
    await (await call(w, attempt.token, "a")).text();
    // The mission's own dollar budget is spent.
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: job.missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await command(w, w.owner, "mission.budget.set", "b-tight", { missionId: job.missionId, budget: { maxMicroUsd: 1, memberCap: 3, attemptReserveMicroUsd: 0 } }, version);
    const stopped = await call(w, attempt.token, "a");
    expect(stopped.status).toBe(403);
    expect(await stopped.text()).not.toMatch(/quota|rate limit|429/iu);
    expect(fake.seen).toHaveLength(1);
  });

  it("stops every call of a workspace whose daily cap is used up", async () => {
    const w = world();
    const fake = upstream({ a: "ok" });
    w.brain.modelFetch = fake.fetch;
    await set(w, "c-1", [route("a")]);
    const job = await secondAttempt(w, "c1");
    const attempt = running(w, job.runner, "req-c1");
    await command(w, w.owner, "workspace.spendCap.set", "cap-0", { dailyMicroUsd: 0 });
    expect((await call(w, attempt.token, "a")).status).toBe(403);
    expect(fake.seen).toHaveLength(0);
  });
});
