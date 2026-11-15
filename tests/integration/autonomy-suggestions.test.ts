import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, AutonomySuggestion } from "@brain/contracts";
import { AUTONOMY_PRESETS } from "../../apps/governor/src/domain/mission-policy";
import { workView } from "../helpers";
import { autonomyWorld, closeAutonomyWorlds, finishTasks, judgeRejected, missionOf, missionWithTasks, read, run, sendBack, suggestionFor, suggestions, tasksOf, type AutonomyWorld } from "../support/autonomy-world";

// Autonomy suggestions earned from a track record (#158, ADR 0066) at the Governor seam. State is reached through commands and queries; the only
// seeded rows are the verdicts a real evaluator run would leave (as finishTask does). A suggestion is worked out on every read, so a regression
// withdraws it without anything being stored.
afterEach(closeAutonomyWorlds);

const bearer = (ctx: AutonomyWorld) => new Headers({ authorization: `Bearer ${ctx.w.ownerToken}` });
const attention = async (ctx: AutonomyWorld) => (await read<{ items: AttentionItem[] }>(ctx, "attention.list")).items;
const decide = (ctx: AutonomyWorld, kind: "accept" | "dismiss", key: string, subject: { kind: string; subjectId: string }) => run(ctx, `autonomy.suggestion.${kind}`, key, subject);

/** The administrator's ceiling, set with a fresh step-up the way the Administration page does. */
async function setCeiling(ctx: AutonomyWorld, preset: string, key: string): Promise<void> {
  const { w } = ctx;
  const workspace = w.brain.store.control.prepare("SELECT version FROM workspaces WHERE id=?").get(w.workspaceId) as { version: number };
  const identity = await w.brain.resolveActor(bearer(ctx), w.workspaceId);
  const challenge = w.brain.stepUp.createCommandChallenge(identity, { commandType: "workspace.autonomyCeiling.set", workspaceId: w.workspaceId, payload: { workspaceId: w.workspaceId, preset } as never });
  const evidence = await w.brain.stepUp.verifyCommand(identity, challenge.challengeId, "", bearer(ctx));
  await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workspace.autonomyCeiling.set", workspaceId: w.workspaceId, idempotencyKey: key, expectedVersion: workspace.version, payload: { workspaceId: w.workspaceId, preset, stepUpEvidenceId: evidence.evidenceId } } as never, key, bearer(ctx));
}
const itemOf = async (ctx: AutonomyWorld, missionId: string, taskId: string) => (await workView(ctx.w)).items.find((entry) => entry.missionId === missionId && entry.planTaskId === taskId)!;

describe("autonomy suggestions: thresholds, figures and evidence", () => {
  it("suggests nothing below the sample minimum, then one step up with its figures, their definitions and the evidence", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "m1", 6, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 4));
    expect((await suggestions(ctx)).items).toEqual([]);
    await finishTasks(ctx, id, ["t5"]);

    const found = await suggestionFor(ctx, "mission", id);
    expect(found).toMatchObject({ kind: "mission", subjectId: id, subjectTitle: "Mission m1", from: "supervised", to: "standard" });
    // One step only, never to the top at once.
    expect(found?.to).not.toBe("autonomous");
    const byId = new Map(found!.figures.map((figure) => [figure.id, figure] as const));
    expect(byId.get("completed-tasks")).toMatchObject({ numerator: 5, met: true });
    expect(byId.get("verified-rate")).toMatchObject({ numerator: 5, denominator: 5, value: 1, met: true });
    expect(byId.get("stall-rate")).toMatchObject({ numerator: 0, met: true });
    expect(byId.get("reopened-and-eval-cases")).toMatchObject({ numerator: 0, met: true });
    expect(byId.get("failed-runs")).toMatchObject({ numerator: 0, met: true });
    // Every figure ships its definition and what a suggestion needs; the window and what is counted are stated.
    for (const figure of found!.figures) { expect(figure.definition.length).toBeGreaterThan(20); expect(figure.needed.length).toBeGreaterThan(0); }
    expect(byId.get("completed-tasks")?.definition).toMatch(/at least 5/u);
    expect(found?.window.days).toBe(30);
    expect(found?.counted).toMatchObject({ windowOnly: true });
    expect(found?.counted.definition).toMatch(/rejected verdict|failed run/u);
    expect(found?.evidence.missionIds).toEqual([id]);
    expect(found?.effectsNote).toMatch(/never approves an effect/u);
    // It is worked out, not stored: the only table that exists for it holds decisions, and none was made.
    expect((await suggestions(ctx)).decisions).toEqual([]);
  });

  it("is never an attention item: the attention list is identical with and without a suggestion", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "quiet", 6, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 4));
    const before = await attention(ctx);
    await finishTasks(ctx, id, ["t5"]);
    expect((await suggestions(ctx)).items).toHaveLength(1);
    const after = await attention(ctx);
    // Finishing a task may add its own "result ready" item; a suggestion adds nothing of its own kind.
    expect(after.filter((item) => !before.some((old) => old.id === item.id)).every((item) => item.kind === "result-ready")).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(/autonomy|suggest/iu);
    await decide(ctx, "accept", "quiet-accept", { kind: "mission", subjectId: id });
    expect(JSON.stringify(await attention(ctx))).not.toMatch(/autonomy|suggest/iu);
  });
});

describe("autonomy suggestions: the workspace ceiling", () => {
  it("never suggests beyond the ceiling, and refuses an acceptance the ceiling no longer allows", async () => {
    const ctx = autonomyWorld();
    await setCeiling(ctx, "standard", "ceiling-standard");
    // A mission already at standard has nowhere to go under a standard ceiling.
    const atCeiling = await missionWithTasks(ctx, "top", 5);
    await finishTasks(ctx, atCeiling, tasksOf(1, 5));
    expect(await suggestionFor(ctx, "mission", atCeiling)).toBeUndefined();
    // One at supervised may still be raised, but only to the ceiling.
    const below = await missionWithTasks(ctx, "below", 5, { autonomy: "supervised" });
    await finishTasks(ctx, below, tasksOf(1, 5));
    expect(await suggestionFor(ctx, "mission", below)).toMatchObject({ from: "supervised", to: "standard" });
    // The administrator lowers the ceiling after the suggestion was read: the stale acceptance is refused and nothing changes.
    await setCeiling(ctx, "supervised", "ceiling-supervised");
    await expect(decide(ctx, "accept", "stale-accept", { kind: "mission", subjectId: below })).rejects.toThrow(/no longer holds/u);
    expect((await missionOf(ctx, below)).autonomyPolicy.preset).toBe("supervised");
    expect(await suggestionFor(ctx, "mission", below)).toBeUndefined();
  });
});

describe("autonomy suggestions: dismissal", () => {
  it("is remembered, and the suggestion returns only after new evidence", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "nag", 12, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    expect(await suggestionFor(ctx, "mission", id)).toBeDefined();

    const receipt = await decide(ctx, "dismiss", "nag-dismiss", { kind: "mission", subjectId: id });
    expect(receipt.accepted).toBe(true);
    expect((await missionOf(ctx, id)).autonomyPolicy.preset).toBe("supervised");
    expect((await suggestions(ctx)).items).toEqual([]);
    expect((await suggestions(ctx, `mission:${id}`)).decisions).toEqual([expect.objectContaining({ decision: "dismissed", from: "supervised", to: "standard", decidedBy: "owner-1" })]);
    // Reading again, and a little more clean work, does not bring it back: fewer than the sample minimum since the dismissal.
    ctx.tick(60_000);
    expect((await suggestions(ctx)).items).toEqual([]);
    await finishTasks(ctx, id, tasksOf(6, 9));
    expect((await suggestions(ctx)).items).toEqual([]);
    // The fifth new task is new evidence: it is suggested again, counting only what happened since.
    await finishTasks(ctx, id, ["t10"]);
    const again = await suggestionFor(ctx, "mission", id);
    expect(again?.figures.find((figure) => figure.id === "completed-tasks")?.numerator).toBe(5);
    expect(again?.counted).toMatchObject({ windowOnly: false, reason: "a person last decided on this" });
    // A dismissal is a record, never an edit: it cannot be changed or removed.
    const ws = ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org);
    expect(() => ws.prepare("UPDATE autonomy_decisions SET decision='accepted'").run()).toThrow(/never edited/u);
    expect(() => ws.prepare("DELETE FROM autonomy_decisions").run()).toThrow(/never removed/u);
  });
});

describe("autonomy suggestions: regressions withdraw", () => {
  it("withdraws a pending suggestion at once when a task is sent back, and refuses a late acceptance", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "slip", 8, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    expect(await suggestionFor(ctx, "mission", id)).toBeDefined();

    await sendBack(ctx, id, "t6", "The totals do not add up");
    expect((await read<{ total: number }>(ctx, "evalCases.list")).total).toBe(1);
    expect(await suggestionFor(ctx, "mission", id)).toBeUndefined();
    await expect(decide(ctx, "accept", "slip-late", { kind: "mission", subjectId: id })).rejects.toThrow(/no longer holds/u);
    expect((await missionOf(ctx, id)).autonomyPolicy.preset).toBe("supervised");
    expect((await suggestions(ctx)).decisions).toEqual([]);
  });

  it("withdraws it when a result an independent check judged is not verified", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "reject", 6, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    expect(await suggestionFor(ctx, "mission", id)).toBeDefined();
    judgeRejected(ctx, (await itemOf(ctx, id, "t1")).workItemId, "rejected1");
    expect(await suggestionFor(ctx, "mission", id)).toBeUndefined();
  });

  it("counts only the clean work since the last problem: five new tasks bring it back", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "recover", 12, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    await sendBack(ctx, id, "t12", "Needs another pass");
    expect(await suggestionFor(ctx, "mission", id)).toBeUndefined();
    await finishTasks(ctx, id, tasksOf(6, 9));
    expect(await suggestionFor(ctx, "mission", id)).toBeUndefined();
    await finishTasks(ctx, id, ["t10"]);
    expect((await suggestionFor(ctx, "mission", id))?.figures.find((figure) => figure.id === "completed-tasks")?.numerator).toBe(5);
  });
});

describe("autonomy suggestions: acceptance", () => {
  it("raises the mission one step through the ordinary policy change and records who accepted it and the figures at that time", async () => {
    const ctx = autonomyWorld();
    const id = await missionWithTasks(ctx, "grant", 5, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    const pending = (await suggestionFor(ctx, "mission", id)) as AutonomySuggestion;

    // An agent or a session cannot accept: only a person decides.
    await expect(ctx.w.brain.executeCommand({ ...ctx.w.owner, kind: "agent" }, { contractVersion: "brain.command/v1", commandId: "cmd-agent", commandType: "autonomy.suggestion.accept", workspaceId: ctx.w.workspaceId, idempotencyKey: "agent", payload: { kind: "mission", subjectId: id } } as never, "agent")).rejects.toThrow();
    expect((await missionOf(ctx, id)).autonomyPolicy.preset).toBe("supervised");

    ctx.tick(5000);
    const receipt = await decide(ctx, "accept", "grant-accept", { kind: "mission", subjectId: id });
    expect(receipt.accepted).toBe(true);
    const mission = await missionOf(ctx, id);
    expect(mission.autonomyPolicy.preset).toBe("standard");
    expect([...mission.autonomyPolicy.operations].sort()).toEqual([...AUTONOMY_PRESETS.standard].sort());
    const [record] = (await suggestions(ctx, `mission:${id}`)).decisions;
    expect(record).toMatchObject({ decision: "accepted", kind: "mission", subjectId: id, from: "supervised", to: "standard", decidedBy: "owner-1" });
    expect(record?.figures).toEqual(pending.figures);
    expect(record?.decisionId).toBe(receipt.resourceId);
    // Nothing is left to decide on: the next step needs five new tasks since this acceptance.
    expect(await suggestionFor(ctx, "mission", id)).toBeUndefined();
    await expect(decide(ctx, "accept", "grant-twice", { kind: "mission", subjectId: id })).rejects.toThrow(/no longer holds/u);
  });
});

describe("autonomy suggestions: a Play and a repeated plan", () => {
  it("suggests raising a Play's preset from the missions it started, and its next mission takes it within the ceiling", async () => {
    const ctx = autonomyWorld();
    const play = "checklist-runbook";
    let finished = 0;
    for (let n = 0; n < 4 && finished < 5; n++) {
      const id = (await run(ctx, "mission.create", `play-${n}`, { title: `Runbook ${n}`, playId: play, autoStart: false })).resourceId ?? "";
      const planId = (ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org).prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(id) as { id: string }).id;
      await run(ctx, "plan.confirm", `play-${n}-confirm`, { planVersionId: planId }, (await missionOf(ctx, id)).version);
      const planned = (await workView(ctx.w)).items.filter((entry) => entry.missionId === id).map((entry) => entry.planTaskId);
      await finishTasks(ctx, id, planned);
      finished += planned.length;
    }
    const found = await suggestionFor(ctx, "play", play);
    expect(found).toMatchObject({ kind: "play", subjectId: play, from: "standard", to: "autonomous" });
    expect(found?.evidence.missionIds.length).toBeGreaterThan(1);

    expect((await decide(ctx, "accept", "play-accept", { kind: "play", subjectId: play })).accepted).toBe(true);
    const next = (await run(ctx, "mission.create", "play-next", { title: "Runbook next", playId: play, autoStart: false })).resourceId ?? "";
    expect((await missionOf(ctx, next)).autonomyPolicy.preset).toBe("autonomous");
    expect(await suggestionFor(ctx, "play", play)).toBeUndefined();

    // Under a lower ceiling the Play's preset is still clipped when its next mission is made: acceptance never lifts the ceiling.
    await setCeiling(ctx, "standard", "play-ceiling");
    const clipped = (await run(ctx, "mission.create", "play-clipped", { title: "Runbook clipped", playId: play, autoStart: false })).resourceId ?? "";
    expect((await missionOf(ctx, clipped)).autonomyPolicy.operations).not.toContain("backlog.drop");
  });

  it("suggests turning on automatic confirmation of a repeated plan only for a verified, read-only, standard-or-higher mission; the schedule's gate still decides each run", async () => {
    const ctx = autonomyWorld();
    const source = await missionWithTasks(ctx, "weekly", 5);
    await finishTasks(ctx, source, tasksOf(1, 5));
    await run(ctx, "mission.proposeCompletion", "weekly-propose", { missionId: source }, (await missionOf(ctx, source)).version);
    const bundle = await read<{ digest: string }>(ctx, "missionBundles.latest", source);
    await run(ctx, "mission.verdict.record", "weekly-verdict", { missionId: source, bundleDigest: bundle.digest, outcome: "verified" });
    await run(ctx, "mission.close", "weekly-close", { missionId: source, outcome: "achieved" }, (await missionOf(ctx, source)).version);

    const automationId = (await run(ctx, "automation.upsert", "weekly-schedule", { title: "Repeat: Weekly", target: { kind: "workflow", id: "general-task" }, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, overlap: "queue-one", input: { situation: "Write the weekly report", sourceMissionId: source, autoConfirm: false } })).resourceId ?? "";
    // The switch is on already by default: only a person who turned it off is offered it back.
    const found = await suggestionFor(ctx, "repeat", automationId);
    expect(found).toMatchObject({ kind: "repeat", from: "ask each time", to: "confirm automatically", sourceMissionId: source });
    expect(found?.effectsNote).toMatch(/never approves an effect/u);

    expect((await decide(ctx, "accept", "weekly-accept", { kind: "repeat", subjectId: automationId })).accepted).toBe(true);
    const automation = ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org).prepare("SELECT input_json FROM automations WHERE id=?").get(automationId) as { input_json: string };
    expect(JSON.parse(automation.input_json)).toMatchObject({ autoConfirm: true, sourceMissionId: source, situation: "Write the weekly report" });
    expect(await suggestionFor(ctx, "repeat", automationId)).toBeUndefined();
    expect((await suggestions(ctx, `repeat:${automationId}`)).decisions[0]).toMatchObject({ decision: "accepted", decidedBy: "owner-1", to: "confirm automatically" });
  });
});

describe("autonomy suggestions never touch effects", () => {
  it("leaves effect settings, approvals and the plan operations of a preset untouched, and offers no auto-confirmation for a plan with an effectful step", async () => {
    const ctx = autonomyWorld();
    const control = ctx.w.brain.store.control;
    const ws = ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org);
    const count = (table: string) => (control.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const snapshot = () => JSON.stringify({
      approvals: [count("approval_requests"), count("approval_decisions"), count("approval_consumptions")],
      effects: [count("effect_permits"), count("effect_calls"), control.prepare("SELECT * FROM workspace_effect_policy").all()],
    });
    const id = await missionWithTasks(ctx, "fx", 5, { autonomy: "supervised" });
    await finishTasks(ctx, id, tasksOf(1, 5));
    const before = snapshot();
    expect((await decide(ctx, "accept", "fx-accept", { kind: "mission", subjectId: id })).accepted).toBe(true);
    expect(snapshot()).toBe(before);
    // The presets are lists of plan operations: none of them is an effect, a budget change or a sign-off.
    for (const operations of Object.values(AUTONOMY_PRESETS)) expect(operations.join(" ")).not.toMatch(/effect|approve|budget|close|verdict|intent|constraint/u);

    // A repeated plan whose task runs a workflow missing from the release counts as unsafe, like an effectful one: no suggestion.
    const gated = await missionWithTasks(ctx, "gated", 5);
    const planId = (ws.prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(gated) as { id: string }).id;
    ws.prepare("UPDATE plan_versions SET tasks_json=? WHERE id=?").run(JSON.stringify((JSON.parse((ws.prepare("SELECT tasks_json FROM plan_versions WHERE id=?").get(planId) as { tasks_json: string }).tasks_json) as Array<Record<string, unknown>>).map((task) => ({ ...task, workflowId: "ghost-workflow" }))), planId);
    await finishTasks(ctx, gated, tasksOf(1, 5));
    ws.prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"7".repeat(64)}`, gated, ctx.clock.now);
    ws.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(gated);
    const automationId = (await run(ctx, "automation.upsert", "gated-schedule", { title: "Repeat: gated", target: { kind: "workflow", id: "general-task" }, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, overlap: "queue-one", input: { situation: "x", sourceMissionId: gated, autoConfirm: false } })).resourceId ?? "";
    expect(await suggestionFor(ctx, "repeat", automationId)).toBeUndefined();
  });
});
