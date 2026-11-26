import { MAX_ATTEMPTS, RETRY_DELAYS_MS, signReceipt, resultDigest, type JobOffer } from "@brain/contracts";
import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepAttempts } from "../../apps/governor/src/attempts/routes";
import { enrolRunner, modelTokenOf, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** The queue and the life of an attempt on a runner (docs/architecture.md section 6), and the limits a workspace sets on it. */
const clock = testClock();
const upstream: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let answer: (url: string) => Response = () => Response.json({});
let harness: Harness;
let member: Client;
let workspaceId: string;
let driver: Driver;

const one = (agent: string) => `title = "One step"\n[[step]]\nid = "work"\nagent = "${agent}"\ngoal = "Do the work."\n`;
const start = async (play = "one", workspace = workspaceId): Promise<string> => step(await getTask(harness.admin, workspace, (await harness.admin.command("task.create", { workspaceId: workspace, play })).taskId), "work").id;
const state = async (taskId: string, workspace = workspaceId): Promise<string> => (await getTask(harness.admin, workspace, taskId)).state;
const sweep = (): void => sweepAttempts(harness.governor.gov);
const post = (offer: JobOffer, route: string, body: object, fence = offer.fence) =>
  driver.fetch(`/runner/v1/attempts/${offer.attemptId}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fence, ...body }) });

beforeAll(async () => {
  harness = await createHarness({
    clock,
    fetch: (input, init) => {
      upstream.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> | undefined) }, body: String(init?.body ?? "") });
      return Promise.resolve(answer(String(input)));
    },
  });
  ({ workspaceId } = await makeWorkspace(harness, "Queue", {
    brain: `[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "https://one.example/v1"\nmodel = "small"\nkey = "secret:model-main"\ncontext_tokens = 262144\ncompact_at = 0.6
[[model]]\nname = "spare"\nprovider = "openai-compatible"\nurl = "https://two.example/v1"\nmodel = "large"\nkey = "secret:model-spare"
[[model]]\nname = "claude"\nprovider = "anthropic"\nurl = "https://three.example"\nmodel = "opus"\nkey = "secret:model-claude"
[[project]]\nname = "shop"\nrepo = "https://github.com/acme/shop.git"\n[github]\ncredential = "secret:github"\n`,
    agents: { dev: { tools: ["task.ask", "lookup"] }, needy: { tools: ["docker.ps"] }, hands: { native: "all" }, thrifty: { spend: 0.004 }, prober: { native: "all", spend: 1, commands: 100 } },
    tools: { lookup: 'description = "Looks something up."\neffect = "read"\nsecrets = ["api-key"]\n', "docker.ps": 'description = "Lists containers."\neffect = "read"\nneeds = ["docker"]\n' },
    plays: { one: one("dev"), needy: one("needy"), hands: one("hands"), thrifty: one("thrifty"), prober: one("prober") },
  }));
  for (const [name, value] of [["model-main", "key-one"], ["model-spare", "key-two"], ["model-claude", "key-three"], ["github", "ghp-credential"], ["api-key", "the-api-key"], ["unrelated", "never-leased"]] as const) {
    await harness.admin.command("secret.set", { workspaceId, name, value });
  }
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass(), dev: () => "Done.", hands: () => "Edited." });
});
afterAll(() => harness.close());

describe("a runner", () => {
  it("enrols with a token that works once and is kept nowhere", async () => {
    const issued = await harness.admin.command("runner.token", { name: "second" }, "runner-token-key-1");
    await expect(harness.admin.command("runner.token", { name: "second" }, "runner-token-key-1")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(member.command("runner.token", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { publicKey } = generateKeyPairSync("ed25519");
    const enrol = (token: string) => harness.anonymous.fetch("/runner/v1/enroll", { method: "POST", body: JSON.stringify({ token, name: "second", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }) });
    expect((await enrol("brt_wrong")).status).toBe(403);
    const enrolled = await enrol(issued.token);
    expect(enrolled.status).toBe(200);
    expect((await enrol(issued.token)).status).toBe(403);
    harness.governor.gov.db.pragma("wal_checkpoint(TRUNCATE)");
    const raw = new Database(join(harness.dataDir, "brain.db"), { readonly: true });
    try {
      for (const table of ["idempotency", "events", "runner_tokens", "runners"]) expect(JSON.stringify(raw.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(issued.token);
    } finally {
      raw.close();
    }
    // Without the key's signature over a fresh challenge there is no session.
    const { runnerId } = (await enrolled.json()) as { runnerId: string };
    const challenge = (await (await harness.anonymous.fetch("/runner/v1/challenge", { method: "POST", body: JSON.stringify({ runnerId }) })).json()) as { challengeId: string };
    const hello = await harness.anonymous.fetch("/runner/v1/hello", { method: "POST", body: JSON.stringify({ runnerId, challengeId: challenge.challengeId, signature: "AAAA", capabilities: [], engines: [], slots: 1, freeSlots: 1, version: "x" }) });
    expect(hello.status).toBe(401);
    expect((await harness.anonymous.fetch("/runner/v1/claim", { method: "POST", body: JSON.stringify({ freeSlots: 1 }) })).status).toBe(401);
    const { runners } = await harness.admin.query("runners.list", {});
    expect(runners.map((runner) => [runner.name, runner.online])).toEqual([["second", false], ["test runner", true]]);
    await harness.admin.command("runner.remove", { runnerId });
    expect((await harness.admin.query("runners.list", {})).runners.map((runner) => runner.name)).toEqual(["test runner"]);
  });

  it("is offered only what it can run: one of the agent's engines, what its tools need, and native tools", async () => {
    const needy = await start("needy");
    const hands = await start("hands");
    const plain = await enrolRunner(harness, {}, { name: "plain", capabilities: ["bash"] });
    expect(await plain.claim()).toBeNull();
    const docker = await enrolRunner(harness, { needy: () => "Listed." }, { name: "docker", capabilities: ["bash", "docker"] });
    expect((await docker.step())?.task.id).toBe(needy);
    expect((await driver.step())?.task.id).toBe(hands);
    const other = await enrolRunner(harness, {}, { name: "other engine", engines: ["pi"] });
    expect(await other.claim()).toBeNull();
    await driver.drain();
    expect([await state(needy), await state(hands)]).toEqual(["done", "done"]);
    for (const runner of [plain, docker, other]) await harness.admin.command("runner.remove", { runnerId: runner.runnerId });
  });

  it("holds an attempt by its lease: when it stops renewing, the fence moves and the attempt is queued again after a wait", async () => {
    const taskId = await start();
    const offer = (await driver.claim()) as JobOffer;
    expect(offer).toMatchObject({ kind: "work", fence: 1, task: { id: taskId }, model: { gatewayUrl: "http://localhost:3100/model/v1", routes: [{ provider: "openai-compatible", route: "main", contextTokens: 262144, compactAt: 0.6 }, { provider: "anthropic", route: "claude" }] } });
    expect((await driver.ack(offer)).leaseExpiresAt).toBe(clock.now + 60_000);
    clock.advance(50_000);
    expect((await (await post(offer, "renew", {})).json()) as object).toEqual({ leaseExpiresAt: clock.now + 60_000, stop: false });
    clock.advance(50_000);
    sweep();
    expect(await state(taskId)).toBe("running");
    clock.advance(11_000);
    sweep();
    expect(await state(taskId)).toBe("ready");
    // The old holder is refused everything, and told to stop what it still runs.
    expect((await post(offer, "renew", {})).status).toBe(409);
    expect((await driver.complete(offer, "Too late.")).status).toBe(409);
    expect(await driver.heartbeat([offer.attemptId])).toEqual({ stop: [offer.attemptId] });
    expect(await driver.claim()).toBeNull();
    clock.advance(5_000);
    const again = (await driver.claim()) as JobOffer;
    expect(again).toMatchObject({ attemptId: offer.attemptId, fence: 2 });
    // An offer nobody acknowledges is taken back too.
    clock.advance(31_000);
    sweep();
    expect((await driver.ack(again).catch((e: { status: number }) => e.status))).toBe(409);
    clock.advance(20_000);
    await driver.drain();
    expect(await state(taskId)).toBe("done");
    expect((await getTask(member, workspaceId, taskId)).attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([["work", "succeeded"], ["check", "succeeded"]]);
  });

  it("an attempt that keeps failing for an infrastructure reason is tried again for about six hours, then its task fails naming the limit and a person can retry it", async () => {
    let runs = 0;
    driver.script({ dev: () => { runs += 1; return runs <= MAX_ATTEMPTS ? { outcome: "failed", result: "", failure: { reason: "model-refused", detail: "The model server is down", infrastructure: true } } : "Recovered."; } });
    const taskId = await start();
    for (const wait of [0, ...RETRY_DELAYS_MS]) {
      clock.advance(wait - 1);
      expect(await driver.claim()).toBeNull();
      clock.advance(1);
      await driver.step();
    }
    const failed = await getTask(member, workspaceId, taskId);
    expect(failed).toMatchObject({ state: "failed", result: "The model server is down" });
    expect(failed.attempts.map((attempt) => attempt.state)).toEqual(Array.from({ length: MAX_ATTEMPTS }, () => "failed"));
    expect(failed.attempts.at(-1)?.failure).toMatchObject({ limit: { name: "attempts", value: MAX_ATTEMPTS, used: MAX_ATTEMPTS } });
    expect(await getTask(member, workspaceId, failed.parentId ?? "")).toMatchObject({ state: "needs_you", needs: { kind: "failed-subtask", taskId } });
    // A failure that is the agent's own is not retried at all.
    driver.script({ dev: () => ({ outcome: "failed", result: "", failure: { reason: "limit", detail: "Out of turns", infrastructure: false } }) });
    const second = await start();
    await driver.drain();
    expect((await getTask(member, workspaceId, second)).attempts).toHaveLength(1);
    driver.script({ dev: () => "Recovered." });
    await member.command("task.retry", { workspaceId, taskId: failed.parentId ?? "" });
    await member.command("task.retry", { workspaceId, taskId: second });
    await driver.drain();
    expect([await state(taskId), await state(second), await state(failed.parentId ?? "")]).toEqual(["done", "done", "done"]);
    await expect(member.command("task.retry", { workspaceId, taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is told to stop an attempt whose task a person stopped, and its completion is refused", async () => {
    const taskId = await start();
    const offer = (await driver.claim()) as JobOffer;
    await driver.ack(offer);
    const waiting = await start();
    await member.command("task.stop", { workspaceId, taskId });
    expect((await (await post(offer, "renew", {})).json()) as object).toMatchObject({ stop: true });
    expect(await driver.heartbeat([offer.attemptId])).toEqual({ stop: [offer.attemptId] });
    expect((await driver.complete(offer, "Finished anyway.")).status).toBe(409);
    const stopped = await getTask(member, workspaceId, taskId);
    expect(stopped).toMatchObject({ state: "stopped", result: null });
    expect(stopped.attempts).toMatchObject([{ state: "stopped", failure: { reason: "stopped" } }]);
    await expect(member.command("task.stop", { workspaceId, taskId })).rejects.toMatchObject({ code: "CONFLICT" });
    // Stop everything: every goal of the workspace that has not ended.
    expect(await member.command("workspace.stopAll", { workspaceId })).toEqual({ stopped: 2 });
    expect(await state(waiting)).toBe("stopped");
    expect(await driver.claim()).toBeNull();
    expect((await member.query("today", { workspaceId })).running).toEqual([]);
  });

  it("completes only with a receipt signed by its own key over this attempt and this result", async () => {
    const taskId = await start();
    const offer = (await driver.claim()) as JobOffer;
    await driver.ack(offer);
    const forged = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const receipt = { attemptId: offer.attemptId, fence: offer.fence, snapshotDigest: offer.snapshotDigest, resultDigest: resultDigest("Forged.", null) };
    const body = { outcome: "succeeded", result: "Forged.", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 }, engine: "fixture", baseCommits: {}, stateCommits: {}, receipt: { receipt, signature: signReceipt(receipt, forged) } };
    expect((await post(offer, "complete", body)).status).toBe(403);
    expect(await state(taskId)).toBe("running");
    const done = await driver.complete(offer, "Real.");
    expect(done.status).toBe(200);
    // The same completion sent again, because its answer was lost, is accepted and changes nothing.
    expect((await driver.complete(offer, "Real.")).status).toBe(200);
    await driver.drain();
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "Real." });
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("fetches only the stored bytes its attempt names, and leases only the secrets its agent's tools or a project declare", async () => {
    await start();
    const offer = (await driver.claim()) as JobOffer;
    await driver.ack(offer);
    const blob = (digest: string) => driver.fetch(`/runner/v1/blobs/${digest}`);
    expect(await (await blob(offer.agent.promptDigest)).text()).toBe("You are the dev.\n");
    expect(((await (await blob(offer.snapshotDigest)).json()) as { name: string }).name).toBe("Queue");
    // Another workspace's snapshot, and the prompt of an agent only that workspace has, are not this attempt's to read.
    const other = await makeWorkspace(harness, "Other snapshot", { agents: { stranger: {} } });
    const stranger = (await harness.admin.query("workspace.get", { workspaceId: other.workspaceId })).snapshot.agents["stranger"]?.prompt.digest ?? "";
    expect([(await blob((await harness.admin.query("workspace.get", { workspaceId: other.workspaceId })).snapshotDigest)).status, (await blob(stranger)).status, (await blob("not-a-digest")).status]).toEqual([404, 404, 404]);
    const lease = async (name: string, use: object) => { const response = await post(offer, "secret", { name, use }); return response.ok ? ((await response.json()) as { value: string }).value : response.status; };
    expect(await lease("api-key", { tool: "lookup" })).toBe("the-api-key");
    expect(await lease("github", { project: "shop" })).toBe("ghp-credential");
    expect(await lease("unrelated", { tool: "lookup" })).toBe(403);
    expect(await lease("model-main", { tool: "lookup" })).toBe(403);
    expect(await lease("api-key", { tool: "docker.ps" })).toBe(403);
    expect(await lease("github", { project: "elsewhere" })).toBe(403);
    expect(offer.projects).toEqual([{ name: "shop", repo: "https://github.com/acme/shop.git", branch: "main", access: "write", network: ["*"], credential: "github" }]);
    expect(offer.tools.map((tool) => [tool.name, tool.effect, tool.secrets, tool.files.map((file) => file.path)])).toEqual([["task.ask", "read", [], []], ["lookup", "read", ["api-key"], ["run.sh"]]]);
    await driver.finish(offer);
    expect((await blob(offer.agent.promptDigest)).status).toBe(404);
    expect(await lease("api-key", { tool: "lookup" })).toBe(409);
    await driver.drain();
  });

  it("reaches models only through the gateway, which holds the keys, moves to the next model on a refusal and records what each call used", async () => {
    await start();
    const offer = (await driver.claim()) as JobOffer;
    await driver.ack(offer);
    const token = await modelTokenOf(driver, offer);
    const call = (path: string, auth: Record<string, string>, body: object = { model: "whatever", messages: [{ role: "user", content: "hi" }] }) =>
      harness.anonymous.fetch(`/model/v1/${path}`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
    expect((await call("chat/completions", { authorization: "Bearer bmt_not.a.real.token" })).status).toBe(401);

    upstream.length = 0;
    answer = (url) => (url.startsWith("https://one.example") ? Response.json({ error: { message: "quota" } }, { status: 429 }) : Response.json({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.0042 } }));
    const served = await call("chat/completions", { authorization: `Bearer ${token}` });
    expect([served.status, ((await served.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content]).toEqual([200, "hello"]);
    expect(upstream.map((request) => [request.url, request.headers["authorization"], (JSON.parse(request.body) as { model: string }).model])).toEqual([
      ["https://one.example/v1/chat/completions", "Bearer key-one", "small"], ["https://two.example/v1/chat/completions", "Bearer key-two", "large"],
    ]);

    // A stream is handed on as it is; its last frame carries the figures.
    upstream.length = 0;
    answer = () => new Response('data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    const stream = await call("chat/completions", { authorization: `Bearer ${token}` }, { stream: true, messages: [] });
    expect(await stream.text()).toContain('data: {"choices":[{"delta":{"content":"he"}}]}');
    expect((JSON.parse(upstream[0]?.body ?? "{}") as { stream_options: object }).stream_options).toEqual({ include_usage: true });

    upstream.length = 0;
    answer = () => Response.json({ content: [{ type: "text", text: "bonjour" }], usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 7 } });
    expect(await (await call("messages", { "x-api-key": token, "anthropic-version": "2023-06-01" })).json()).toMatchObject({ content: [{ text: "bonjour" }] });
    expect(upstream.map((request) => [request.url, request.headers["x-api-key"], request.headers["authorization"]])).toEqual([["https://three.example/v1/messages", "key-three", undefined]]);

    const attempt = () => getTask(member, workspaceId, offer.task.id).then((task) => task.attempts[0]);
    expect((await attempt())?.usage).toEqual({ inputTokens: 230, outputTokens: 42, cachedInputTokens: 160, microUsd: 4200 });
    // The runner's own count does not replace what the gateway measured; the token ends with the attempt.
    await driver.complete(offer, { result: "Done.", usage: { inputTokens: 1, outputTokens: 1, microUsd: 100 } });
    expect(await attempt()).toMatchObject({ model: "claude", usage: { inputTokens: 230, outputTokens: 42, cachedInputTokens: 160, microUsd: 4200 } });
    expect((await call("chat/completions", { authorization: `Bearer ${token}` })).status).toBe(401);
    expect(JSON.stringify(offer)).not.toMatch(/key-one|key-two|key-three|ghp-credential/u);
    await driver.drain();
    answer = () => Response.json({});
  });

  it("lets a workspace with no model of its own call the admin workspace's model, with the admin workspace's key", async () => {
    const hub = await makeWorkspace(harness, "Hub", { platform: "admin", packs: ["core"], brain: `[[model]]\nname = "shared"\nprovider = "openai-compatible"\nurl = "https://shared.example/v1"\nmodel = "common"\nkey = "secret:model-shared"\n` });
    await harness.admin.command("secret.set", { workspaceId: hub.workspaceId, name: "model-shared", value: "key-shared" });
    const bare = await makeWorkspace(harness, "Bare", { noModel: true, agents: { dev: { tools: [] } }, plays: { one: one("dev") } });
    await start("one", bare.workspaceId);
    const offer = (await driver.claim()) as JobOffer;
    expect(offer.workspaceId).toBe(bare.workspaceId);
    expect(offer.model.routes.map((one) => one.route)).toEqual(["shared"]);
    // A model that says nothing of its window gets the defaults: 200000 tokens, compacted at 0.7.
    expect(offer.model.routes[0]).toMatchObject({ contextTokens: 200_000, compactAt: 0.7 });
    await driver.ack(offer);
    const token = await modelTokenOf(driver, offer);
    upstream.length = 0;
    answer = () => Response.json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const served = await harness.anonymous.fetch("/model/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: [] }) });
    expect(served.status).toBe(200);
    expect(upstream.map((request) => [request.url, request.headers["authorization"]])).toEqual([["https://shared.example/v1/chat/completions", "Bearer key-shared"]]);
    expect((await harness.admin.query("workspace.get", { workspaceId: bare.workspaceId })).inheritedModels).toEqual([{ name: "shared", model: "common", workspace: hub.slug }]);
    await driver.complete(offer, { result: "Done." });
    await driver.drain();
    answer = () => Response.json({});
  });

  it("is refused further model calls by the gateway once its agent's spend limit is used up", async () => {
    driver.script({ thrifty: () => "Stopped at the limit." });
    await start("thrifty");
    const offer = (await driver.claim()) as JobOffer;
    await driver.ack(offer);
    const token = await modelTokenOf(driver, offer);
    answer = () => Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0042 } });
    const call = () => harness.anonymous.fetch("/model/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: [] }) });
    const first = await call();
    await first.text();
    upstream.length = 0;
    const second = await call();
    expect([first.status, second.status, upstream.length]).toEqual([200, 403, 0]);
    expect(((await second.json()) as { error: { message: string } }).error.message).toContain("spend limit");
    await driver.finish(offer);
    await driver.drain();
    answer = () => Response.json({});
  });

  it("is refused by the gateway, for an agent with model_in_commands, once its tokens are used up, and its commands from 80% of them, whatever the calls cost", async () => {
    driver.script({ prober: () => "Stopped at the limit." });
    await start("prober");
    const offer = (await driver.claim()) as JobOffer;
    expect(offer.agent.modelInCommands).toBe(true);
    await driver.ack(offer);
    const token = await modelTokenOf(driver, offer);
    answer = () => Response.json({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 20 } });
    const call = async (path: string) => {
      const response = await harness.anonymous.fetch(path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: [] }) });
      return { status: response.status, body: await response.text() };
    };
    const [command, own] = ["/model/v1/commands/chat/completions", "/model/v1/chat/completions"] as const;
    // 40 tokens a call, of 100: the commands are refused at 80, the agent's own calls at 100.
    expect([(await call(command)).status, (await call(command)).status]).toEqual([200, 200]);
    upstream.length = 0;
    const early = await call(command);
    expect([early.status, upstream.length]).toEqual([403, 0]);
    expect(early.body).toContain("80%");
    expect((await call(own)).status).toBe(200);
    const spent = await call(own);
    expect([spent.status, upstream.length]).toEqual([403, 1]);
    expect(spent.body).toContain("token limit");
    await driver.finish(offer);
    await driver.drain();
    answer = () => Response.json({});
  });

  it("prices a call from its token counts when the model server reports no cost, and records no cost for a model without prices", async () => {
    const priced = await makeWorkspace(harness, "Priced", {
      brain: `[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "https://priced.example/v1"\nmodel = "small"\ninput_usd_per_mtok = 2\noutput_usd_per_mtok = 10
[[model]]\nname = "spare"\nprovider = "openai-compatible"\nurl = "https://unpriced.example/v1"\nmodel = "large"\n`,
      agents: { dev: {} }, plays: { one: one("dev") },
    });
    const run = async (answers: Array<(url: string) => Response>) => {
      const taskId = await start("one", priced.workspaceId);
      const offer = (await driver.claim()) as JobOffer;
      await driver.ack(offer);
      const token = await modelTokenOf(driver, offer);
      for (const next of answers) {
        answer = next;
        await (await harness.anonymous.fetch("/model/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: [] }) })).text();
      }
      await driver.finish(offer);
      await driver.drain();
      answer = () => Response.json({});
      return (await getTask(harness.admin, priced.workspaceId, taskId)).attempts[0];
    };
    const tokens = { prompt_tokens: 1000, completion_tokens: 500 };
    // 1000 tokens in at $2 a million and 500 out at $10 a million; a cost the model server states itself is taken as it is.
    expect(await run([() => Response.json({ choices: [], usage: tokens }), () => Response.json({ choices: [], usage: { ...tokens, cost: 0.001 } })]))
      .toMatchObject({ model: "main", priced: true, usage: { inputTokens: 2000, outputTokens: 1000, microUsd: 7000 + 1000 } });
    // The first model is out of quota, the next one has no prices: its tokens are counted and cost nothing on record.
    expect(await run([(url) => (url.startsWith("https://priced.example") ? Response.json({}, { status: 429 }) : Response.json({ choices: [], usage: tokens }))]))
      .toMatchObject({ model: "spare", priced: false, usage: { inputTokens: 1000, outputTokens: 500, microUsd: 0 } });
    expect((await harness.admin.query("usage.summary", { workspaceId: priced.workspaceId, days: 1 })).total).toMatchObject({ microUsd: 8000, inputTokens: 3000 });
  });

  it("is given a person's answer to the agent's question in the next attempt", async () => {
    driver.script({
      dev: async ({ offer, brain }) => {
        if (offer.context.answers.length > 0) return `Deployed to ${offer.context.answers[0]?.answer}.`;
        expect(await brain("task.ask", { question: "Which region: eu or us?" })).toEqual({ state: "done", output: { status: "waiting" } });
        return "I asked which region and am waiting.";
      },
    });
    const taskId = await start();
    await driver.drain();
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "needs_you", needs: { kind: "answer", question: "Which region: eu or us?" } });
    const viewer = await harness.member(workspaceId, "vera@example.com", "viewer");
    await expect(viewer.command("task.answer", { workspaceId, taskId, answer: "eu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await member.command("task.answer", { workspaceId, taskId, answer: "eu" });
    await expect(member.command("task.answer", { workspaceId, taskId, answer: "us" })).rejects.toMatchObject({ code: "CONFLICT" });
    const offers = await driver.drain();
    expect(offers[0]?.context.answers).toEqual([{ question: "Which region: eu or us?", answer: "eu", by: "max", at: clock.now }]);
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "Deployed to eu." });
    driver.script({ dev: () => "Done." });
  });
});

describe("the record of an attempt and the health of what runs it", () => {
  it("task.events reads what the attempt reported, in order, from where the reader stopped", async () => {
    driver.script({ dev: async ({ event }) => { await event({ kind: "status", phase: "engine", detail: "started" }); await event({ kind: "text", channel: "assistant", text: "Working on it." }); await event({ kind: "native.call", callId: "n1", name: "bash", input: { command: "ls" } }); return "Done."; } });
    const taskId = await start();
    await driver.drain();
    const attemptId = (await getTask(member, workspaceId, taskId)).attempts[0]?.id ?? "";
    const { events } = await member.query("task.events", { workspaceId, taskId, attemptId });
    expect(events.map((event) => [event.seq, event.kind])).toEqual([[1, "status"], [2, "text"], [3, "native.call"]]);
    expect((await member.query("task.events", { workspaceId, taskId, attemptId, after: 2 })).events).toMatchObject([{ seq: 3, kind: "native.call", name: "bash", input: { command: "ls" } }]);
    await expect(member.query("task.events", { workspaceId, taskId, attemptId: "a_elsewhere" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true, state: "done", limit: 1 })).tasks).toMatchObject([{ title: "One step", state: "done", parentId: null }]);
    driver.script({ dev: () => "Done." });
  });

  it("health says which runners are online, whether each model answers, that the audit log verifies, and when the last backup was", async () => {
    upstream.length = 0;
    answer = (url) => (url.startsWith("https://two.example") ? Response.json({ error: "bad key" }, { status: 401 }) : Response.json({ data: [] }));
    await driver.heartbeat([]);
    const health = await member.query("health", { workspaceId });
    expect(health.runners).toMatchObject([{ name: "test runner", online: true }]);
    expect(health.models).toEqual([{ name: "main", reachable: true, detail: "", priced: false }, { name: "spare", reachable: false, detail: "The model server refused the key", priced: false }, { name: "claude", reachable: true, detail: "", priced: false }]);
    expect(upstream.map((request) => request.url)).toEqual(["https://one.example/v1/models", "https://two.example/v1/models", "https://three.example/v1/models"]);
    expect(health.audit).toMatchObject({ problem: null, events: expect.any(Number) });
    expect(health.backup).toEqual({ lastAt: null });
    writeFileSync(join(harness.dataDir, "backup.marker"), "");
    clock.advance(46_000);
    const later = await member.query("health", { workspaceId });
    expect(later.backup.lastAt).toBeGreaterThan(0);
    expect(later.runners).toMatchObject([{ online: false }]);
    expect(((await (await harness.anonymous.fetch("/health/ready")).json()) as { ready: boolean }).ready).toBe(true);
    answer = () => Response.json({});
  });
});

describe("a workspace's limits", () => {
  it("0 means no cap: running_tasks starts every ready task, and an agent's turns and tokens reach the runner as 0", async () => {
    const open = await makeWorkspace(harness, "Open", { brain: "[limits]\nrunning_tasks = 0\ndaily_spend_usd = 0\n", agents: { dev: { uncapped: true } }, plays: { one: one("dev") } });
    const ids = [await start("one", open.workspaceId), await start("one", open.workspaceId), await start("one", open.workspaceId)];
    expect(await Promise.all(ids.map((id) => getTask(harness.admin, open.workspaceId, id).then((task) => task.attempts.length)))).toEqual([1, 1, 1]);
    const offer = (await driver.claim()) as JobOffer;
    expect(offer.agent.limits).toMatchObject({ turns: 0, tokens: 0, spendMicroUsd: 0 });
    await driver.ack(offer);
    expect(await driver.claim()).not.toBeNull();
    await driver.finish(offer);
    await driver.drain();
  });

  it("running_tasks: no more tasks run at once, and the runner serves the workspace with the fewest running first", async () => {
    const limited = await makeWorkspace(harness, "Limited", { brain: "[limits]\nrunning_tasks = 1\n", agents: { dev: {} }, plays: { one: one("dev") } });
    const first = await start("one", limited.workspaceId);
    const second = await start("one", limited.workspaceId);
    const mine = await start();
    const count = (taskId: string, workspace: string) => getTask(harness.admin, workspace, taskId).then((task) => task.attempts.length);
    // Every ready task is queued; the workspace's limit is applied when a runner claims.
    expect([await count(first, limited.workspaceId), await count(second, limited.workspaceId)]).toEqual([1, 1]);
    const offer = (await driver.claim()) as JobOffer;
    expect(offer.task.id).toBe(first);
    await driver.ack(offer);
    // The older workspace has one running now: the other workspace's attempt goes first, and the limited one gets nothing more meanwhile.
    expect((await driver.step())?.task.id).toBe(mine);
    await driver.step();
    expect(await driver.claim()).toBeNull();
    await driver.finish(offer);
    await driver.drain();
    expect([await state(first, limited.workspaceId), await state(second, limited.workspaceId), await state(mine)]).toEqual(["done", "done", "done"]);
  });

  it("daily_spend_usd: nothing more is claimed once the day's spend plus what a new attempt may spend would pass the cap", async () => {
    const capped = await makeWorkspace(harness, "Capped", { brain: "[limits]\ndaily_spend_usd = 1\n", agents: { dev: { spend: 0.4 }, checker: { spend: 0.1 } }, plays: { one: one("dev") } });
    const spend = () => harness.admin.query("today", { workspaceId: capped.workspaceId }).then((today) => today.spend);
    driver.script({ dev: () => ({ result: "Done.", usage: { inputTokens: 1000, outputTokens: 200, microUsd: 700_000 } }) });
    const first = await start("one", capped.workspaceId);
    const offer = (await driver.claim()) as JobOffer;
    // While it runs, the attempt holds what its agent may spend.
    expect(await spend()).toEqual({ todayMicroUsd: 400_000, capMicroUsd: 1_000_000, unpriced: true });
    await driver.ack(offer);
    await driver.finish(offer);
    expect(await spend()).toEqual({ todayMicroUsd: 700_000, capMicroUsd: 1_000_000, unpriced: true });
    await driver.step();
    const second = await start("one", capped.workspaceId);
    expect(await driver.claim()).toBeNull();
    expect([await state(first, capped.workspaceId), await state(second, capped.workspaceId)]).toEqual(["done", "ready"]);
    const summary = await harness.admin.query("usage.summary", { workspaceId: capped.workspaceId, days: 7 });
    expect(summary).toMatchObject({ total: { microUsd: 700_000, inputTokens: 1000, outputTokens: 200 }, byAgent: [{ agent: "checker", microUsd: 0 }, { agent: "dev", microUsd: 700_000 }], byDay: [{ day: "2026-11-16", microUsd: 700_000 }] });
    // The next day the cap is whole again.
    clock.now = Date.UTC(2026, 10, 17, 0, 5);
    expect((await spend()).todayMicroUsd).toBe(0);
    driver.script({ dev: () => "Done." });
    await driver.drain();
    expect(await state(second, capped.workspaceId)).toBe("done");
  });
});
