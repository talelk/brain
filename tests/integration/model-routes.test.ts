import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { attemptRouteUses, eligibleRoutes, modelRoutesFor } from "../../apps/governor/src/modules/jobs/index";
import { recordProbe } from "../../apps/governor/src/modules/operations/index";
import { DIGEST_A, setupWorld, type TestWorld } from "../helpers";
import { command } from "../support/reuse";
import { fixtureStarter } from "../support/starter";

// ADR 0055 at the Governor's command/query boundary: a workspace holds an ordered list of model routes; a job is offered the eligible ones in
// order (enabled, up, not out of quota, accepted by the agent); a quota refusal reported by the runner leaves a route out of later offers
// until its retry-after passed; each attempt records which route served it. State is reached through commands and the runner protocol.
const worlds: TestWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); delete process.env["BRAIN_MODEL_KEY_ACME_A"]; });

const clock = { now: Date.now() };
const route = (routeId: string, extra: Record<string, unknown> = {}) => ({
  routeId, enabled: true, vendor: "Acme", keyRef: `acme-${routeId}`, model: `model-${routeId}`, baseUrl: `https://${routeId}.acme.example/v1`, costTier: "standard",
  inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000, ...extra,
});

/** A starter release whose task-worker agent states what it wants of the routes, re-pinned everywhere the workflows name it. */
function starter(preference: Record<string, unknown>) {
  const bundle = fixtureStarter();
  const replacements = new Map<string, string>();
  for (const doc of bundle.documents) {
    const value = JSON.parse(doc.text);
    if (value.kind !== "Agent" || value.metadata.id !== "task-worker") continue;
    const prior = sha256Digest(new TextEncoder().encode(doc.text));
    Object.assign(value.spec, preference);
    doc.text = JSON.stringify(value, null, 2) + "\n";
    replacements.set(prior, sha256Digest(new TextEncoder().encode(doc.text)));
  }
  for (const doc of bundle.documents) for (const [prior, next] of replacements) doc.text = doc.text.replaceAll(prior, next);
  return bundle;
}

function world(preference: Record<string, unknown> = {}): TestWorld {
  clock.now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock: { nowMs: () => clock.now, monotonicMs: () => clock.now } }));
  const bundle = starter(preference);
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}
const set = (w: TestWorld, key: string, routes: Array<Record<string, unknown>>): Promise<CommandReceipt> => command(w, w.owner, "workspace.modelRoutes.set", key, { routes });
const settings = async (w: TestWorld) => ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: { modelRoutes: Array<Record<string, unknown>> } }).snapshot.modelRoutes;
const order = (w: TestWorld, role: "evaluator" | "second-attempt" | "judge" = "evaluator") => eligibleRoutes(w.brain.store, w.workspaceId, role).routes.map((entry) => entry.routeId);

describe("model routes are an ordered list the owner sets in one command", () => {
  it("keeps the order given, lets it be rearranged, and refuses a list that cannot be run", async () => {
    const w = world();
    await set(w, "o-1", [route("a"), route("b"), route("c")]);
    expect((await settings(w)).map((entry) => [entry["routeId"], entry["position"]])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(order(w)).toEqual(["a", "b", "c"]);
    await set(w, "o-2", [route("c"), route("a"), route("b")]);
    expect(order(w)).toEqual(["c", "a", "b"]);
    // Refused whole: two routes of one name, a ninth route, a key pasted in place of its reference, a missing price.
    await expect(set(w, "o-dup", [route("a"), route("a")])).rejects.toThrow(/Two routes are named a/);
    await expect(set(w, "o-many", Array.from({ length: 9 }, (_, n) => route(`r${n}`)))).rejects.toThrow();
    await expect(set(w, "o-key", [route("a", { keyRef: "sk-1234567890abcdef" })])).rejects.toThrow(/short reference/);
    await expect(set(w, "o-price", [route("a", { outputMicroUsdPerMTok: 0 })])).rejects.toThrow();
    expect(order(w)).toEqual(["c", "a", "b"]);
    await set(w, "o-none", []);
    expect(order(w)).toEqual([]);
  });

  it("skips a route that is switched off or whose health check says it is down", async () => {
    const w = world();
    await set(w, "e-1", [route("a", { enabled: false }), route("b"), route("c")]);
    expect(order(w)).toEqual(["b", "c"]);
    recordProbe(w.brain.store, `hosted:${w.workspaceId}/b`, "unavailable", "down");
    expect(order(w)).toEqual(["c"]);
    expect((await settings(w)).map((entry) => entry["status"])).toEqual(["off", "down", "unknown"]);
    recordProbe(w.brain.store, `hosted:${w.workspaceId}/c`, "unavailable", "down");
    // Every route that would serve is down: the role waits (blocked), it does not fall back to the self-hosted model.
    expect(eligibleRoutes(w.brain.store, w.workspaceId, "evaluator")).toMatchObject({ routes: [], blocked: true });
  });

  it("never carries a key: the settings, the offer and the event hold the reference only", async () => {
    process.env["BRAIN_MODEL_KEY_ACME_A"] = "super-secret-key-value";
    const w = world();
    await set(w, "k-1", [route("a")]);
    const seen = [JSON.stringify(await settings(w)), JSON.stringify(w.brain.store.control.prepare("SELECT payload_json FROM events WHERE event_type='workspace.modelRoutesSet'").all())];
    expect(seen.join("\n")).toContain("acme-a");
    expect(seen.join("\n")).not.toContain("super-secret-key-value");
  });
});

describe("a quota refusal moves work to the next route and is recorded per attempt", () => {
  /** A queued agent job of a task on its second attempt (a model slip), and a runner able to take it. */
  async function secondAttempt(w: TestWorld, key: string): Promise<{ runner: { runnerId: string; epoch: number; organizationId: string }; jobId: string; runId: string }> {
    const s = w.brain.store;
    const planId = (await command(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false })).resourceId ?? "";
    const plan = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId: planId, origin: "manual", tasks: [{ id: "a", title: "Task a", criteria: ["a-done"], dependsOn: [] }] })).resourceId ?? "";
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: planId })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: plan }, version);
    const db = s.workspaceDb(w.workspaceId, w.org);
    const workItemId = (db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(planId) as { id: string }).id;
    const runId = `run-${key}`;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, workItemId, runId);
    db.prepare("UPDATE work_items SET failed_attempts=1, failure_class='model-slip' WHERE id=?").run(workItemId);
    const jobId = `job-${key}`;
    const placement = { group: "fixture-tools", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], isolation: "ephemeral-container", resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 } };
    s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
      VALUES (?,?,?,?,?, 'work', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', 0, ?, ?, ?)`)
      .run(jobId, w.org, w.workspaceId, `key-${jobId}`, runId, w.brain.activeRelease(w.org)!.digest, JSON.stringify(placement), DIGEST_A, s.now(), s.now(), s.now() + 3_600_000);
    s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, "dispatch", JSON.stringify({ step: { uses: { type: "agent", release: { id: "task-worker", digest: DIGEST_A } } } }));
    const runnerId = `runner-${key}`;
    s.control.prepare(`INSERT OR IGNORE INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, 4)`).run(runnerId, w.org, DIGEST_A, s.now());
    for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
      s.control.prepare("INSERT OR IGNORE INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3_600_000);
    }
    return { runner: { runnerId, epoch: 1, organizationId: w.org }, jobId, runId };
  }
  const offeredRoutes = (w: TestWorld, jobId: string): string[] => ((JSON.parse((w.brain.store.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string }).payload_json) as { modelRoutes?: Array<{ routeId: string }> }).modelRoutes ?? []).map((entry) => entry.routeId);
  /** Takes the attempt and ends it the way the runner does, reporting the routes it tried. */
  function finish(w: TestWorld, runner: { runnerId: string; epoch: number; organizationId: string }, request: string, report: unknown[], result: "succeeded" | "failed"): string {
    const offer = w.brain.jobProtocol.claim(runner, request) as unknown as { attemptId: string; leaseId: string; jobFence: number };
    w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result, jobFence: offer.jobFence, cleanupConfirmed: true, output: result === "failed" ? { error: "quota or rate limit (retry after 45s): 429" } : { ok: true }, modelRoutes: report });
    return offer.attemptId;
  }

  it("offers the eligible routes in order, records the one that served and the one passed, and leaves the refused route out until its retry-after has passed", async () => {
    const w = world();
    await set(w, "f-1", [route("a"), route("b"), route("c")]);
    const first = await secondAttempt(w, "f1");
    const attemptId = finish(w, first.runner, "req-f1", [{ routeId: "a", outcome: "quota", retryAfterMs: 45_000 }, { routeId: "b", outcome: "served" }], "succeeded");
    expect(offeredRoutes(w, first.jobId)).toEqual(["a", "b", "c"]);
    expect(attemptRouteUses(w.brain.store, attemptId)).toEqual([{ routeId: "a", model: "model-a", outcome: "quota" }, { routeId: "b", model: "model-b", outcome: "served" }]);
    // Spend is attributed to the model that answered, not the one the attempt started on (#111).
    expect((w.brain.store.control.prepare("SELECT reported_model AS model FROM job_attempts WHERE id=?").get(attemptId) as { model: string }).model).toBe("model-b");
    // The run inspector says which route served the attempt.
    const job = ((await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: first.jobId } as never)) as unknown as { snapshot: { attempts?: Array<{ modelRoutes?: unknown }> } }).snapshot;
    expect(JSON.stringify(job)).toContain('"outcome":"served"');
    // Account a is out of quota for the provider's 45 seconds: the next job is offered b and c, never a blind retry on a.
    expect((await settings(w))[0]).toMatchObject({ routeId: "a", status: "quota" });
    const second = await secondAttempt(w, "f2");
    w.brain.jobProtocol.claim(second.runner, "req-f2");
    expect(offeredRoutes(w, second.jobId)).toEqual(["b", "c"]);
    // After the wait it is first again.
    clock.now += 46_000;
    expect(order(w, "evaluator")).toEqual(["a", "b", "c"]);
    expect((await settings(w))[0]).toMatchObject({ routeId: "a", status: "unknown" });
  });

  it("holds the work while every route is out of quota, and offers it with the route again once the wait is over", async () => {
    const w = world();
    await set(w, "h-1", [route("a")]);
    const first = await secondAttempt(w, "h1");
    finish(w, first.runner, "req-h1", [{ routeId: "a", outcome: "quota", retryAfterMs: 60_000 }], "failed");
    const second = await secondAttempt(w, "h2");
    expect(w.brain.jobProtocol.claim(second.runner, "req-h2")).toBeNull();
    clock.now += 61_000;
    w.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id=?").run(clock.now, second.runner.runnerId);
    expect(w.brain.jobProtocol.claim(second.runner, "req-h3")).toMatchObject({ attemptId: expect.any(String) });
    expect(offeredRoutes(w, second.jobId)).toEqual(["a"]);
  });

  it("ignores a report that names a route the job was not offered", async () => {
    const w = world();
    await set(w, "i-1", [route("a")]);
    const only = await secondAttempt(w, "i1");
    const attemptId = finish(w, only.runner, "req-i1", [{ routeId: "elsewhere", outcome: "quota" }, { routeId: "a", outcome: "served" }], "succeeded");
    expect(attemptRouteUses(w.brain.store, attemptId)).toEqual([{ routeId: "a", model: "model-a", outcome: "served" }]);
    expect(order(w)).toEqual(["a"]);
  });
});

describe("an agent definition names preferred routes or a cost tier", () => {
  const offeredFor = (w: TestWorld, kind = "dispatch") => modelRoutesFor(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, runId: "pref-run", kind, configDigest: w.brain.activeRelease(w.org)!.digest, agentId: "task-worker" });

  it("tries the agent's preferred routes first, in the order the agent names them", async () => {
    const w = world({ modelRoutes: ["c", "b"] });
    await set(w, "p-1", [route("a"), route("b"), route("c")]);
    expect(offeredFor(w, "eval").routes.map((entry) => entry.routeId)).toEqual(["c", "b", "a"]);
  });

  it("takes a cost tier as a ceiling: routes of that tier or a cheaper one, and none when nothing fits", async () => {
    const w = world({ costTier: "low" });
    await set(w, "t-1", [route("big", { costTier: "premium" }), route("mid", { costTier: "standard" }), route("small", { costTier: "low" })]);
    expect(offeredFor(w, "eval").routes.map((entry) => entry.routeId)).toEqual(["small"]);
    await set(w, "t-2", [route("big", { costTier: "premium" })]);
    // Nothing the agent accepts: the check runs self-hosted rather than on a route the agent refused.
    expect(offeredFor(w, "eval")).toMatchObject({ routes: [], held: false });
  });
});
