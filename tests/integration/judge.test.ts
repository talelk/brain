import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionEvidenceBundle, PlanTask, UsageView } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { BundleJudge } from "../../apps/governor/src/application/bundle-judge";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { judgeCostMicroUsd, parseJudgeResponse } from "../../apps/governor/src/modules/packs/judge";
import { setupWorld, type TestWorld } from "../helpers";
import { finishTask } from "../support/finish-task";
import { command, getMission } from "../support/reuse";
import { scaled } from "../support/timing";

// The advisory judge (T44, #95, ADR 0023): when a mission's evidence bundle is submitted and the workspace has a hosted model, the Governor
// asks it for one opinion per success criterion and writes each as an advisory check with its transcript as evidence. It never records a
// verdict or changes the bundle, never blocks sign-off, writes nothing without a model reply, and its calls are mission spend under the caps.
// Everything below reaches state through commands and queries; the model is a fake behind the Governor's fetch port.
let world: TestWorld | undefined;
const keyBefore = process.env["BRAIN_MODEL_KEY_ACME_JUDGE"];
afterEach(() => {
  world?.brain.close(); world = undefined;
  if (keyBefore === undefined) delete process.env["BRAIN_MODEL_KEY_ACME_JUDGE"]; else process.env["BRAIN_MODEL_KEY_ACME_JUDGE"] = keyBefore;
});

const HOSTED = { routeId: "judge", enabled: true, vendor: "Acme", keyRef: "acme-judge", costTier: "standard", model: "acme-judge", baseUrl: "https://judge.acme.example/v1", inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000 };
const USAGE = { prompt_tokens: 1000, completion_tokens: 100 };
/** 1000 x 150000 + 100 x 600000 micro-USD per million tokens, rounded up. */
const CALL_COST = 210;

interface FakeModel { calls: Array<{ url: string; authorization: string | null; prompt: string }>; reply: (prompt: string) => Promise<Response> | Response; fetch: typeof fetch }
function fakeModel(reply: FakeModel["reply"] = () => answer("pass", "the evidence settles it")): FakeModel {
  const model: FakeModel = {
    calls: [], reply,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return model.reply === DOWN ? new Response("down", { status: 503 }) : new Response("{}", { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[0]!.content;
      model.calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), prompt });
      return model.reply(prompt);
    }) as typeof fetch,
  };
  return model;
}
const answer = (verdict: string, rationale: string, usage: Record<string, number> | null = USAGE): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict, rationale }) } }], ...(usage ? { usage } : {}) }), { status: 200 });
const DOWN = (): Response => new Response("unavailable", { status: 503 });

const query = async <T>(w: TestWorld, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const latestBundle = (w: TestWorld, id: string) => query<MissionEvidenceBundle>(w, "missionBundles.latest", id);
const task = (id: string, serves: string[]): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], ...(serves.length ? { criterionIds: serves } : {}) });
const missionUsage = async (w: TestWorld, id: string) => (await query<{ usage: { settledMicroUsd: number; inputTokens: number; outputTokens: number; estimated: boolean } }>(w, "usage.mission", id)).usage;

/** A mission with three success criteria: c1 and c2 are each served by a finished task with a handoff the judge can read; nobody serves c3. */
const missionsOf = new WeakMap<TestWorld, number>();
async function finishedMission(w: TestWorld, key: string): Promise<string> {
  const n = missionsOf.get(w) ?? 0;
  missionsOf.set(w, n + 1);
  const [digestA, digestB] = ["0123456789abcdef"[n * 2]!, "0123456789abcdef"[n * 2 + 1]!]; // each seeded evidence bundle needs its own digest
  const id = (await command(w, w.owner, "mission.create", `${key}-create`, { title: `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["Facts are listed", "A recommendation is made", "Risks are named"], autoStart: false })).resourceId ?? "";
  const planId = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task("a", ["c1"]), task("b", ["c2"])] })).resourceId ?? "";
  await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  await finishTask(w, id, "a", digestA, undefined, "Listed the twelve facts with their sources.");
  await finishTask(w, id, "b", digestB, undefined, "Recommended the staged rollout.");
  return id;
}
/** Submits the bundle the way a person's "Finish mission" does, then lets the judge's pass the command started finish. */
async function submit(w: TestWorld, id: string, key: string): Promise<MissionEvidenceBundle> {
  const receipt = await command(w, w.owner, "mission.proposeCompletion", key, { missionId: id }, (await getMission(w, id)).version);
  expect(receipt.accepted).toBe(true);
  await w.brain.bundleJudge.sweep();
  return latestBundle(w, id);
}
const useHostedModel = async (w: TestWorld, model: FakeModel, config: Record<string, unknown> = HOSTED): Promise<void> => {
  w.brain.modelFetch = model.fetch;
  expect((await command(w, w.owner, "workspace.modelRoutes.set", `hosted-${w.brain.store.now()}-${model.calls.length}`, { routes: [config] })).accepted).toBe(true);
};
const judgeChecks = (bundle: MissionEvidenceBundle) => (bundle.checks ?? []).filter((check) => check.evaluator.startsWith("judge:"));

describe("judge response parsing (T44)", () => {
  it("maps verdicts and fails closed on garbage", () => {
    expect(parseJudgeResponse('{"verdict":"pass","rationale":"ok"}')).toEqual({ outcome: "passed", rationale: "ok" });
    expect(parseJudgeResponse('text before {"verdict":"fail","rationale":"missing"} after')).toEqual({ outcome: "failed", rationale: "missing" });
    expect(parseJudgeResponse('{"verdict":"inconclusive","rationale":"weak"}').outcome).toBe("incomplete");
    expect(parseJudgeResponse("PASS definitely").outcome).toBe("incomplete");
    expect(parseJudgeResponse('{"verdict":"yes"}').outcome).toBe("incomplete");
    expect(parseJudgeResponse("").outcome).toBe("incomplete");
  });

  it("prices a call as tokens times the route's prices, rounded up, never free", () => {
    expect(judgeCostMicroUsd(HOSTED, { inputTokens: 1000, outputTokens: 100 })).toBe(CALL_COST);
    expect(judgeCostMicroUsd(HOSTED, { inputTokens: 1, outputTokens: 0 })).toBe(1);
  });
});

describe("the advisory judge on a submitted mission bundle (#95)", () => {
  it("writes an advisory check per readable criterion with its transcript, never a verdict, and charges the mission", async () => {
    world = setupWorld();
    const w = world;
    process.env["BRAIN_MODEL_KEY_ACME_JUDGE"] = "sk-test-key";
    const model = fakeModel((prompt) => (prompt.includes("recommendation") ? answer("fail", "no recommendation is stated") : answer("pass", "twelve facts are listed")));
    await useHostedModel(w, model);
    const id = await finishedMission(w, "judged");
    const bundle = await submit(w, id, "judged-finish");

    // The bundle is still the person's to judge: the opinion changed nothing about it.
    expect(bundle).toMatchObject({ state: "submitted", complete: true, judge: { state: "done", model: "acme-judge" } });
    expect(bundle.independence).toBeUndefined();
    expect((await getMission(w, id)).state).toBe("verifying");
    // Two criteria had readable work behind them; the unserved one got no call and no check.
    expect(model.calls).toHaveLength(2);
    expect(model.calls.every((call) => call.url === "https://judge.acme.example/v1/chat/completions" && call.authorization === "Bearer sk-test-key")).toBe(true);
    expect(model.calls[0]!.prompt).toContain("Listed the twelve facts with their sources.");
    const byId = (criterionId: string) => bundle.coverage.find((entry) => entry.criterionId === criterionId)!;
    expect(byId("c1")).toMatchObject({ checks: [], advisory: [{ name: "judge:acme-judge", outcome: "passed" }] });
    expect(byId("c2")).toMatchObject({ checks: [], advisory: [{ name: "judge:acme-judge", outcome: "failed" }] });
    expect(byId("c3")).toMatchObject({ workItems: [], checks: [], advisory: [] });
    expect(judgeChecks(bundle)).toHaveLength(2);
    expect(judgeChecks(bundle).every((check) => check.advisory)).toBe(true);
    // The transcript is evidence in the workspace's store: what was asked, what was read, what the model said.
    const transcript = JSON.parse(Buffer.from(readVerified(w.brain.store, judgeChecks(bundle)[0]!.evidenceDigest)).toString("utf8")) as Record<string, string>;
    expect(transcript).toMatchObject({ model: "acme-judge", criterionId: "c1", outcome: "passed", rationale: "twelve facts are listed" });
    expect(transcript["evidence"]).toContain("Listed the twelve facts with their sources.");
    // Its calls are the mission's spend, priced from the hosted model's prices, and count in the workspace's totals.
    expect(await missionUsage(w, id)).toMatchObject({ settledMicroUsd: 2 * CALL_COST, inputTokens: 2000, outputTokens: 200, estimated: false });
    expect((await query<{ usage: { settledMicroUsd: number } }>(w, "usage.workspace")).usage.settledMicroUsd).toBe(2 * CALL_COST);
    // It is attributed too (#111): a judge source on the hosted model, with no agent, member or engine, and every grouping still sums to the total.
    const view = await query<UsageView>(w, "usage.mission", id);
    for (const dimension of ["member", "agent", "engine", "model"] as const) {
      expect(view.breakdown![dimension], dimension).toEqual([{ source: "judge", ...(dimension === "model" ? { id: "acme-judge" } : {}), usage: expect.objectContaining({ settledMicroUsd: 2 * CALL_COST, inputTokens: 2000, outputTokens: 200, attempts: 2 }) }]);
    }

    // A pass is not a link and not a verdict: the person still decides, and the opinion stays beside the evidence afterwards.
    expect((await command(w, w.owner, "mission.verdict.record", "judged-verdict", { missionId: id, bundleDigest: bundle.digest, outcome: "verified" })).accepted).toBe(true);
    const verified = await latestBundle(w, id);
    expect(verified).toMatchObject({ state: "verified", independence: "L3", judge: { state: "done" } });
    expect(judgeChecks(verified)).toHaveLength(2);
    // Asking again records nothing new: one request per bundle.
    await w.brain.bundleJudge.sweep();
    expect(model.calls).toHaveLength(2);
  }, scaled(60_000));

  it("with no hosted model it records nothing and says no judge ran; switching one on later judges the bundle still waiting", async () => {
    world = setupWorld();
    const w = world;
    const model = fakeModel();
    w.brain.modelFetch = model.fetch;
    const id = await finishedMission(w, "off");
    const bundle = await submit(w, id, "off-finish");
    expect(bundle).toMatchObject({ state: "submitted", judge: { state: "not-run", reason: "hosted-off" } });
    expect(bundle.checks).toEqual([]);
    expect(bundle.coverage.flatMap((entry) => entry.advisory)).toEqual([]);
    expect(model.calls).toHaveLength(0);
    expect((await missionUsage(w, id)).settledMicroUsd).toBe(0);
    // Not a block either: the person can verify.
    await useHostedModel(w, model);
    expect((await latestBundle(w, id)).judge).toEqual({ state: "pending" });
    await w.brain.bundleJudge.sweep();
    expect(await latestBundle(w, id)).toMatchObject({ state: "submitted", judge: { state: "done" } });
    expect(model.calls).toHaveLength(2);
  }, scaled(60_000));

  it("a switched-off hosted model is no judge even when it is saved and priced", async () => {
    world = setupWorld();
    const w = world;
    const model = fakeModel();
    await useHostedModel(w, model, { ...HOSTED, enabled: false });
    const id = await finishedMission(w, "saved-off");
    expect(await submit(w, id, "saved-off-finish")).toMatchObject({ judge: { state: "not-run", reason: "hosted-off" }, checks: [] });
    expect(model.calls).toHaveLength(0);
  }, scaled(60_000));

  it("a model outage fabricates nothing and does not block sign-off; the judge asks again later and gives up after three tries", async () => {
    const clock = { now: Date.now() };
    const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
    world = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock: { nowMs: () => clock.now, monotonicMs: () => clock.now } }));
    const w = world;
    let down = true;
    const model = fakeModel(() => (down ? DOWN() : answer("pass", "ok")));
    await useHostedModel(w, model);
    const id = await finishedMission(w, "outage");
    const bundle = await submit(w, id, "outage-finish");
    expect(bundle).toMatchObject({ state: "submitted", judge: { state: "unavailable", reason: "model-unavailable", detail: "the hosted model answered HTTP 503" }, checks: [] });
    expect(bundle.coverage.flatMap((entry) => entry.advisory)).toEqual([]);
    expect((await missionUsage(w, id)).settledMicroUsd).toBe(0);
    // Not before the retry delay.
    const asked = model.calls.length;
    await w.brain.bundleJudge.sweep();
    expect(model.calls).toHaveLength(asked);
    // The model is back: the next try after the delay judges the bundle.
    down = false; clock.now += 6 * 60_000;
    await w.brain.bundleJudge.sweep();
    expect(await latestBundle(w, id)).toMatchObject({ state: "submitted", judge: { state: "done" } });
    expect(judgeChecks(await latestBundle(w, id))).toHaveLength(2);

    // A second mission: the model never comes back. Three tries, then the sign-off view says the judge was unavailable, and the verdict records.
    down = true;
    const other = await finishedMission(w, "outage-2");
    expect((await submit(w, other, "outage-2-finish")).judge.state).toBe("unavailable");
    const before = model.calls.length;
    for (let round = 0; round < 4; round += 1) { clock.now += 6 * 60_000; await w.brain.bundleJudge.sweep(); }
    expect(model.calls.length - before).toBe(2);
    const stuck = await latestBundle(w, other);
    expect(stuck).toMatchObject({ judge: { state: "unavailable", reason: "model-unavailable" }, checks: [] });
    expect((await command(w, w.owner, "mission.verdict.record", "outage-2-verdict", { missionId: other, bundleDigest: stuck.digest, outcome: "verified" })).accepted).toBe(true);
    expect(await latestBundle(w, other)).toMatchObject({ state: "verified", independence: "L3", judge: { state: "unavailable" } });
  }, scaled(60_000));

  it("waits while the hosted model's health probe says it is down, then judges", async () => {
    world = setupWorld();
    const w = world;
    const model = fakeModel(DOWN);
    await useHostedModel(w, model);
    await w.brain.runEngineProbes();
    const id = await finishedMission(w, "probe");
    expect(await submit(w, id, "probe-finish")).toMatchObject({ judge: { state: "pending" }, checks: [] });
    expect(model.calls).toHaveLength(0);
    model.reply = () => answer("pass", "ok");
    await w.brain.runEngineProbes();
    await w.brain.bundleJudge.sweep();
    expect(await latestBundle(w, id)).toMatchObject({ judge: { state: "done" } });
    expect(judgeChecks(await latestBundle(w, id))).toHaveLength(2);
  }, scaled(60_000));

  it("moves to the next model route when one answers 429, prices each call with the route that answered, and does not ask the refused route again", async () => {
    world = setupWorld();
    const w = world;
    process.env["BRAIN_MODEL_KEY_ACME_SECOND"] = "second-key";
    const calls: Array<{ url: string; authorization: string | null }> = [];
    w.brain.modelFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response("{}", { status: 200 });
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.startsWith("https://judge.acme.example") ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) : answer("pass", "ok");
    }) as typeof fetch;
    const second = { ...HOSTED, routeId: "second", keyRef: "acme-second", model: "acme-second", baseUrl: "https://second.acme.example/v1", inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 1_200_000 };
    expect((await command(w, w.owner, "workspace.modelRoutes.set", "two-routes", { routes: [HOSTED, second] })).accepted).toBe(true);
    const id = await finishedMission(w, "failover");
    const bundle = await submit(w, id, "failover-finish");
    // The first route was asked once (its 429 left it out of line); the second answered both criteria with its own key.
    expect(calls.filter((call) => call.url.startsWith("https://judge.acme.example"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith("https://second.acme.example")).map((call) => call.authorization)).toEqual(["Bearer second-key", "Bearer second-key"]);
    expect(bundle).toMatchObject({ judge: { state: "done" } });
    expect(judgeChecks(bundle).map((check) => check.evaluator)).toEqual(["judge:acme-second", "judge:acme-second"]);
    // 1000 x 300000 + 100 x 1200000 micro-USD per million tokens = 420 per call, the answering route's prices.
    expect((await missionUsage(w, id)).settledMicroUsd).toBe(2 * 420);
    const settings = ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: { modelRoutes: Array<{ routeId: string; status: string }> } }).snapshot.modelRoutes;
    expect(settings.map((entry) => [entry.routeId, entry.status])).toEqual([["judge", "quota"], ["second", "unknown"]]);
    delete process.env["BRAIN_MODEL_KEY_ACME_SECOND"];
  }, scaled(60_000));

  it("an unreadable reply is an inconclusive opinion, never a pass", async () => {
    world = setupWorld();
    const w = world;
    await useHostedModel(w, fakeModel(() => new Response(JSON.stringify({ choices: [{ message: { content: "PASS definitely" } }] }), { status: 200 })));
    const id = await finishedMission(w, "garbled");
    const bundle = await submit(w, id, "garbled-finish");
    expect(judgeChecks(bundle).map((check) => check.outcome)).toEqual(["incomplete", "incomplete"]);
    // The reply carried no token counts: the cost is an estimate, and says so.
    expect((await missionUsage(w, id)).estimated).toBe(true);
  }, scaled(60_000));

  it("the workspace spend cap and the mission's own dollar budget each stop the judge's next call", async () => {
    world = setupWorld();
    const w = world;
    const model = fakeModel();
    await useHostedModel(w, model);
    // A cap of zero admits nothing: no call, no check, and the view says why.
    await command(w, w.owner, "workspace.spendCap.set", "cap-0", { dailyMicroUsd: 0 });
    const first = await finishedMission(w, "cap-zero");
    expect(await submit(w, first, "cap-zero-finish")).toMatchObject({ state: "submitted", judge: { state: "not-run", reason: "budget" }, checks: [] });
    expect(model.calls).toHaveLength(0);
    // A cap one call exhausts: the first criterion is judged, the second is not.
    await command(w, w.owner, "workspace.spendCap.set", "cap-200", { dailyMicroUsd: 200 });
    const second = await finishedMission(w, "cap-one");
    const stopped = await submit(w, second, "cap-one-finish");
    expect(stopped.judge).toEqual({ state: "done", reason: "budget", model: "acme-judge" });
    expect(judgeChecks(stopped)).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    expect((await missionUsage(w, second)).settledMicroUsd).toBe(CALL_COST);
    // The mission's own budget binds the same way, whatever the workspace allows.
    await command(w, w.owner, "workspace.spendCap.set", "cap-none", {});
    const third = await finishedMission(w, "budget");
    await command(w, w.owner, "mission.budget.set", "budget-tight", { missionId: third, budget: { maxMicroUsd: 100, memberCap: 3, attemptReserveMicroUsd: 0 } }, (await getMission(w, third)).version);
    const tight = await submit(w, third, "budget-finish");
    expect(tight.judge).toEqual({ state: "done", reason: "budget", model: "acme-judge" });
    expect(judgeChecks(tight)).toHaveLength(1);
  }, scaled(60_000));

  it("a verdict recorded while the judge is still asking leaves no opinion on the replaced bundle or the next one", async () => {
    world = setupWorld();
    const w = world;
    const id = await finishedMission(w, "late");
    let rejected = false;
    const model = fakeModel(async () => {
      if (!rejected) {
        rejected = true;
        const current = await latestBundle(w, id);
        expect((await command(w, w.owner, "mission.verdict.record", "late-reject", { missionId: id, bundleDigest: current.digest, outcome: "rejected", findings: ["The facts need a source"] })).accepted).toBe(true);
      }
      return answer("pass", "ok");
    });
    await useHostedModel(w, model);
    const first = await submit(w, id, "late-finish-1");
    expect(first).toMatchObject({ state: "rejected", judge: { state: "not-run", reason: "too-late" }, checks: [] });
    // The call was made and answered, so it was paid for; its opinion was dropped.
    expect(model.calls).toHaveLength(1);
    expect((await missionUsage(w, id)).settledMicroUsd).toBe(CALL_COST);
    // Finishing again is a new bundle with its own judge request.
    const second = await submit(w, id, "late-finish-2");
    expect(second.digest).not.toBe(first.digest);
    expect(second).toMatchObject({ state: "submitted", judge: { state: "done" } });
    expect(judgeChecks(second)).toHaveLength(2);
  }, scaled(60_000));

  it("a judge request a restart left half done is resumed, without asking again about what it already judged", async () => {
    world = setupWorld();
    const w = world;
    const model = fakeModel();
    await useHostedModel(w, model);
    const id = await finishedMission(w, "restart");
    // The first process dies while its first call is unanswered (the cap lets a single call through, the same as a crash after one).
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    model.reply = async () => { await held; return answer("pass", "ok"); };
    const receipt = await command(w, w.owner, "mission.proposeCompletion", "restart-finish", { missionId: id }, (await getMission(w, id)).version);
    expect(receipt.accepted).toBe(true);
    await expect.poll(() => model.calls.length).toBe(1);
    expect((await latestBundle(w, id)).judge.state).toBe("running");
    // The new process has no judge in flight: its first pass takes the request over.
    model.reply = () => answer("pass", "ok");
    await new BundleJudge({ store: w.brain.store, modelFetch: () => model.fetch }).sweep();
    expect(await latestBundle(w, id)).toMatchObject({ state: "submitted", judge: { state: "done" } });
    expect(judgeChecks(await latestBundle(w, id))).toHaveLength(2);
    release();
    await w.brain.bundleJudge.sweep();
    // The old process's late answers are the same opinions on the same bundle and the same ledger rows: still two checks, still two calls paid.
    expect(judgeChecks(await latestBundle(w, id))).toHaveLength(2);
    expect((await missionUsage(w, id)).settledMicroUsd).toBe(2 * CALL_COST);
  }, scaled(60_000));
});
