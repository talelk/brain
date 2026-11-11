import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, CommandReceipt, Mission, PlanTask } from "@brain/contracts";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { effectfulStep } from "../../apps/governor/src/modules/missions/repeat";

/** ADR 0017: a repeated mission's plan is confirmed by its schedule only when every safety condition holds. */
type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);

/** The starter release plus a read-only single-step workflow. */
function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
  const read = JSON.parse(source.text);
  read.metadata.id = "general-single";
  delete read.spec.jobs["validate"];
  read.spec.outputs["passed"] = { source: "literal", value: true };
  bundle.documents.push({ path: "config/general-single.yaml", text: JSON.stringify(read, null, 2) + "\n" });
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}

const task = (id: string, workflowId = "general-single"): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is written up`], dependsOn: [], workflowId });
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;

/** A mission with a confirmed plan that has finished and been verified as achieved: what "Repeat this" is offered on. */
async function achieved(w: World, key: string, options: { autonomy?: string } = {}): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: "Weekly report", intent: "Write the weekly report", successCriteria: ["delivered"], ...(options.autonomy ? { autonomy: options.autonomy } : {}), budget: { maxMicroUsd: 2_000_000, memberCap: 2 } })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task("gather"), task("write")] })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  verifyAndClose(w, id);
  return id;
}
let bundles = 0;
function verifyAndClose(w: World, id: string, outcome = "achieved"): void {
  db(w).prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${(++bundles).toString(16).padStart(64, "0")}`, id, Date.now());
  db(w).prepare("UPDATE missions SET state='closed', outcome=? WHERE id=?").run(outcome, id);
}

const schedule = async (w: World, input: Record<string, unknown>, target: { kind: string; id: string } = { kind: "workflow", id: "general-task" }) =>
  (await run(w, "automation.upsert", `auto-${Math.random()}`, { title: "Repeat: Weekly report", target, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, overlap: "queue-one", input })).resourceId ?? "";
const fire = async (w: World, automationId: string): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run(w, "automation.control", `now-${Math.random()}`, { automationId, action: "runNow" });
  const items = (w.brain.jobProtocol.automations.query(w.owner, "automations.occurrences", w.workspaceId, automationId) as unknown as { items: Array<{ state: string; dispatchRef?: string; detail?: string }> }).items;
  const latest = items.find((entry) => entry.state === "dispatched" && entry.dispatchRef && !seen.has(entry.dispatchRef));
  if (!latest?.dispatchRef) throw new Error(`no new mission: ${JSON.stringify(items)}`);
  seen.add(latest.dispatchRef);
  return latest.dispatchRef;
};
const seen = new Set<string>();
const planOf = (w: World, missionId: string) => db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=? ORDER BY revision DESC").get(missionId) as { state: string };
const events = (w: World, type: string) => (db(w).prepare("SELECT payload_json FROM events WHERE event_type=? ORDER BY cursor").all(type) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
const attention = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "attention.list" })) as unknown as { snapshot: { items: AttentionItem[] } }).snapshot.items;
const held = async (w: World, reason: RegExp, missionId: string) => {
  expect(planOf(w, missionId).state).toBe("proposed");
  expect(events(w, "plan.heldBySchedule").at(-1)?.["reason"]).toMatch(reason);
  const item = (await attention(w)).find((entry) => entry.kind === "plan-proposal" && entry.missionId === missionId);
  expect(item?.title).toMatch(/needs your OK: /u);
  expect(item?.title).toMatch(reason);
};

describe("a schedule confirms a repeated plan only under its safety conditions (ADR 0017)", () => {
  it("confirms an identical, verified, read-only plan on behalf of the person who created the schedule, and records it", async () => {
    const w = world();
    const source = await achieved(w, "ok");
    const automationId = await schedule(w, { situation: "Write the weekly report", sourceMissionId: source });
    const m1 = await fire(w, automationId);
    expect(planOf(w, m1).state).toBe("confirmed");
    expect(await mission(w, m1)).toMatchObject({ state: "active", budget: { maxMicroUsd: 2_000_000, memberCap: 2 } });
    expect((db(w).prepare("SELECT plan_task_id FROM work_items WHERE mission_id=? ORDER BY plan_task_id").all(m1) as Array<{ plan_task_id: string }>).map((row) => row.plan_task_id)).toEqual(["gather", "write"]);
    expect(events(w, "plan.confirmedBySchedule").at(-1)).toMatchObject({ missionId: m1, automationId, createdBy: "owner-1", note: `confirmed by schedule ${automationId} created by owner-1` });
    expect((await attention(w)).filter((entry) => entry.missionId === m1 && entry.kind === "plan-proposal")).toEqual([]);
  });

  it("stops at a drafted plan, with the reason in Needs you, when the switch is off", async () => {
    const w = world();
    const source = await achieved(w, "off");
    const m = await fire(w, await schedule(w, { situation: "x", sourceMissionId: source, autoConfirm: false }));
    await held(w, /asks? you each time/u, m);
  });

  it("stops when the mission it repeats was not verified as achieved", async () => {
    const w = world();
    const source = await achieved(w, "unverified");
    db(w).prepare("UPDATE missions SET outcome='ended' WHERE id=?").run(source);
    await held(w, /not verified as achieved/u, await fire(w, await schedule(w, { situation: "x", sourceMissionId: source })));
  });

  it("stops when the schedule names no confirmed mission", async () => {
    const w = world();
    await held(w, /no confirmed mission/u, await fire(w, await schedule(w, { situation: "Summarise the week\n\nDone when:\n- the summary is written" })));
  });

  it("stops when the mission's autonomy is below standard", async () => {
    const w = world();
    const source = await achieved(w, "supervised", { autonomy: "supervised" });
    await held(w, /autonomy is below standard/u, await fire(w, await schedule(w, { situation: "x", sourceMissionId: source })));
  });

  it("stops when the budget leaves no room to start", async () => {
    const w = world();
    const source = await achieved(w, "broke");
    db(w).prepare("UPDATE missions SET budget_micro_usd=100, attempt_reserve_micro_usd=500 WHERE id=?").run(source);
    await held(w, /money limit leaves no room/u, await fire(w, await schedule(w, { situation: "x", sourceMissionId: source })));
  });

  it("stops when the person who created the schedule can no longer confirm plans", async () => {
    const w = world();
    const source = await achieved(w, "owner-gone");
    const automationId = await schedule(w, { situation: "x", sourceMissionId: source });
    w.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id='owner-1'").run(Date.now());
    const m = await fire(w, automationId);
    await held(w, /can no longer confirm plans/u, m);
  });

  it("starts a Play occurrence from the confirmed plan, and shows what changed when the Play was re-planned", async () => {
    const w = world();
    const id = (await run(w, "mission.create", "play-create", { title: "Weekly status", playId: "weekly-status" })).resourceId ?? "";
    const proposed = db(w).prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(id) as { id: string };
    await run(w, "plan.confirm", "play-confirm", { planVersionId: proposed.id }, (await mission(w, id)).version);
    verifyAndClose(w, id);
    const automationId = await schedule(w, { sourceMissionId: id }, { kind: "play", id: "weekly-status" });
    const same = await fire(w, automationId);
    expect(planOf(w, same).state).toBe("confirmed");
    expect(events(w, "plan.confirmedBySchedule")).toHaveLength(1);

    // The person edited the confirmed plan after the first run, so the Play's plan is now a re-plan against it.
    const tasks = JSON.parse((db(w).prepare("SELECT tasks_json FROM plan_versions WHERE id=?").get(proposed.id) as { tasks_json: string }).tasks_json) as PlanTask[];
    tasks[0] = { ...tasks[0]!, title: "Collect everything twice" };
    db(w).prepare("UPDATE plan_versions SET tasks_json=? WHERE id=?").run(JSON.stringify(tasks), proposed.id);
    const changed = await fire(w, automationId);
    await held(w, /the plan changed since you confirmed it \(changed collect\)/u, changed);
    expect(events(w, "plan.heldBySchedule").at(-1)?.["diff"]).toMatchObject({ changed: ["collect"] });
  });

  it("puts a failed occurrence in Needs you until a later run starts", async () => {
    const w = world();
    const automationId = await schedule(w, {}, { kind: "play", id: "ghost-play" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run(w, "automation.control", "now-ghost", { automationId, action: "runNow" });
    const item = (await attention(w)).find((entry) => entry.kind === "schedule-failed");
    expect(item).toMatchObject({ resourceId: automationId, tier: 2 });
    expect(item?.title).toMatch(/could not start its latest run/u);
    expect(item?.detail).toMatch(/ghost-play/u);
  });

  it("puts a run that ended without its goal in Needs you", async () => {
    const w = world();
    const source = await achieved(w, "ended");
    const automationId = await schedule(w, { situation: "x", sourceMissionId: source });
    const m = await fire(w, automationId);
    db(w).prepare("UPDATE missions SET state='closed', outcome='ended' WHERE id=?").run(m);
    const item = (await attention(w)).find((entry) => entry.kind === "schedule-failed");
    expect(item).toMatchObject({ missionId: m, resourceId: automationId });
  });

  it("does not skip the next run while the previous mission only waits for a sign-off on verified evidence", async () => {
    const w = world();
    const source = await achieved(w, "overlap");
    const automationId = await schedule(w, { situation: "x", sourceMissionId: source });
    const first = await fire(w, automationId);
    db(w).prepare("UPDATE missions SET state='verifying' WHERE id=?").run(first);
    expect(w.brain.missions.isOpen(w.org, w.workspaceId, first)).toBe(true);
    db(w).prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"8".repeat(64)}`, first, Date.now() + 1000);
    expect(w.brain.missions.isOpen(w.org, w.workspaceId, first)).toBe(false);
  });
});

describe("which workflow steps always need a person", () => {
  const workflow = (jobs: Record<string, unknown>) => ({ spec: { jobs } }) as never;
  const flows = {
    reads: workflow({ a: { kind: "dispatch", effectClass: "read" }, b: { kind: "eval" } }),
    writes: workflow({ a: { kind: "dispatch", effectClass: "write" } }),
    privileged: workflow({ a: { kind: "dispatch", effectClass: "privileged" } }),
    gated: workflow({ g: { kind: "gate" } }),
    merges: workflow({ m: { kind: "merge" } }),
    nested: workflow({ s: { kind: "subgraph", workflow: { id: "gated" } } }),
    loop: workflow({ s: { kind: "subgraph", workflow: { id: "loop" } } }),
  };
  it("finds writes, privileged steps, approvals, merges and the same inside a subgraph; read-only work and a cycle pass", () => {
    expect(effectfulStep(flows, "reads")).toBeUndefined();
    expect(effectfulStep(flows, "writes")).toMatch(/can write/u);
    expect(effectfulStep(flows, "privileged")).toMatch(/privileges/u);
    expect(effectfulStep(flows, "gated")).toMatch(/waits for an approval/u);
    expect(effectfulStep(flows, "merges")).toMatch(/merges/u);
    expect(effectfulStep(flows, "nested")).toMatch(/waits for an approval/u);
    expect(effectfulStep(flows, "loop")).toBeUndefined();
    expect(effectfulStep(flows, "missing")).toMatch(/not in the active release/u);
  });
});
