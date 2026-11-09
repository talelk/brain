import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import type { Brain } from "../../apps/governor/src/application/brain";

/**
 * The whole mission loop through the real UI and commands on the fixture engine:
 * create -> plan -> confirm -> tasks start -> runner finishes -> review -> verified
 * evidence -> Done -> dependents unlock -> finish. The only direct write is the planner's proposal row (the
 * "ask Brain" step). Evidence is the real bundle the runner and independent evaluator
 * produce; the plan's criteria are the starter workflow's own check ids.
 */
interface GovernorFixture { url: string; credential: string; app: { brain: Brain } }
interface RunnerSession { cfg: Parameters<typeof runOnce>[0]; sessionToken: string; epoch: number }

async function world(page: Page, governor: GovernorFixture) {
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Flow organization");
  await page.getByLabel(/^Email/).fill("flow@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-flow", slug: "flow" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-flow")).actor;
  const sessions: RunnerSession[] = [];
  for (const group of ["agents", "evaluators"]) {
    const cfg = { governorUrl: governor.url, runnerId: `flow-${group}`, stateDir: join(brain.store.dataDir, group), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const hello = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(actor, group).token);
    sessions.push({ cfg, sessionToken: hello.sessionToken, epoch: hello.epoch });
  }
  const ws = brain.store.workspaceDb("ws-flow", actor.organizationId);
  return { brain, actor: scoped, ws, sessions };
}

type World = Awaited<ReturnType<typeof world>>;
const states = (w: World, missionId: string) => Object.fromEntries((w.ws.prepare("SELECT plan_task_id AS t, state AS s FROM work_items WHERE mission_id=? AND state!='abandoned'").all(missionId) as { t: string; s: string }[]).map((row) => [row.t, row.s]));
const linkedRuns = (w: World, missionId: string, task: string) => (w.ws.prepare("SELECT l.run_id FROM execution_links l JOIN work_items i ON i.id=l.work_item_id WHERE i.mission_id=? AND i.plan_task_id=?").all(missionId, task) as { run_id: string }[]).map((row) => row.run_id);

/** Creates the mission in the New mission form (describe path) and returns its id. */
async function createMission(page: Page, w: World, base: string, sentence: string, manual: boolean): Promise<string> {
  await page.goto(`${base}/w/ws-flow/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByRole("button", { name: /Describe what you want/ }).click();
  await form.getByLabel(/^What do you want done/).fill(sentence);
  if (manual) {
    await form.getByLabel("Starting tasks", { exact: true }).click();
    await page.getByRole("option", { name: "Ask me before each task", exact: true }).click();
  }
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const row = w.ws.prepare("SELECT id, auto_start FROM missions WHERE title LIKE ?").get(`${sentence.slice(0, 20)}%`) as { id: string; auto_start: number };
  expect(row.auto_start).toBe(manual ? 0 : 1);
  return row.id;
}

/** The planner ("ask Brain") step: a proposal the person then reads and confirms in the UI. */
async function proposePlan(w: World, missionId: string, summary: string): Promise<void> {
  const task = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, criteria: ["structure", "safety"], dependsOn, workflowId: "operations-triage" });
  const key = `flow-plan-${missionId}`;
  const { receipt } = await w.brain.executeCommand(w.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-flow", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary, tasks: [task("inspect", "Inspect the sign-in flow"), task("verify", "Verify the correction", ["inspect"])] },
  } as never, key);
  expect(receipt.accepted).toBe(true);
  w.ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, w.actor.actorId, `seed-${key}`, receipt.resourceId, w.brain.store.now(), w.brain.store.now());
}

/** Lets the runners claim and finish every job the run needs (agent step, then independent evaluation). */
async function driveRuns(w: World, until: () => boolean): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("runners did not finish the run in time");
    let worked = false;
    for (const session of w.sessions) worked = (await runOnce(session.cfg, session.sessionToken, session.epoch)) || worked;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function markDone(page: Page, w: World, missionId: string, title: string, task: string): Promise<void> {
  await page.getByRole("button", { name: `Manage ${title}` }).click();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  await page.getByLabel(`Verified evidence for ${title}`, { exact: true }).click();
  await page.getByRole("option", { name: /passed criteria/ }).first().click();
  await page.getByLabel(`Move ${title}`, { exact: true }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move work item", exact: true }).click();
  await expect.poll(() => states(w, missionId)[task]).toBe("done");
  await page.getByRole("button", { name: "Back to mission work", exact: true }).click();
}

test("mission flow (auto): create, confirm, tasks start by themselves, run, review, verified Done, dependents unlock, finish", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await world(page, governor);
  const missionId = await createMission(page, w, governor.url, "Stabilize the sign-in flow end to end", false);

  await proposePlan(w, missionId, "Inspect, then verify the correction");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Inspect, then verify the correction", { exact: true })).toBeVisible();
  expect(Object.keys(states(w, missionId))).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();

  // Confirmation alone starts the ready task; the dependent waits in the backlog.
  await expect.poll(() => states(w, missionId)).toEqual({ inspect: "in-progress", verify: "backlog" });
  const runs = linkedRuns(w, missionId, "inspect");
  expect(runs).toHaveLength(1);
  expect(linkedRuns(w, missionId, "verify")).toHaveLength(0);

  // The runners finish the run; the Governor moves the item to review by itself.
  await driveRuns(w, () => states(w, missionId)["inspect"] === "review");
  expect((w.ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runs[0]) as { state: string }).state).toBe("succeeded");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Finished; waiting for you to check the evidence.")).toBeVisible();

  // Done needs verified evidence, bound explicitly in the UI; then the dependent unlocks and auto-starts.
  // Work others depend on needs the member's handoff before Done. Nothing in the UI or a workflow run submits one
  // (see the report on this spec), so the member's command is issued directly.
  const inspectItem = w.ws.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='inspect'").get(missionId) as { id: string };
  const handoff = await w.brain.executeCommand(w.actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-flow-handoff", commandType: "handoff.submit", workspaceId: "ws-flow", idempotencyKey: "flow-handoff",
    payload: { workItemId: inspectItem.id, notes: { summary: "Sign-in flow inspected" } },
  } as never, "flow-handoff");
  expect(handoff.receipt.accepted).toBe(true);
  await page.reload();
  await markDone(page, w, missionId, "Inspect the sign-in flow", "inspect");
  await expect.poll(() => states(w, missionId)).toEqual({ inspect: "done", verify: "in-progress" });
  expect(linkedRuns(w, missionId, "verify")).toHaveLength(1);

  await driveRuns(w, () => states(w, missionId)["verify"] === "review");
  await page.reload();
  await markDone(page, w, missionId, "Verify the correction", "verify");
  await expect(page.getByText("All work is done", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Finish mission", exact: true }).click();
  await expect.poll(() => (w.ws.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string }).state).toMatch(/^(verifying|closed)$/);
  expect(errors).toEqual([]);
});

test("mission flow (manual): 'Ask me before each task' starts nothing until a person presses Start", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await world(page, governor);
  const missionId = await createMission(page, w, governor.url, "Review the quarterly numbers by hand", true);

  await proposePlan(w, missionId, "Inspect, then verify by hand");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Tasks start when you start them", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => states(w, missionId)).toEqual({ inspect: "ready", verify: "backlog" });

  // Nothing started: no run, a Start action for the ready task and a next-step strip that says so.
  await expect(page.getByRole("button", { name: "Start Inspect the sign-in flow", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "ready to start" }).first()).toBeVisible();
  expect((w.ws.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(0);
  expect(linkedRuns(w, missionId, "inspect")).toHaveLength(0);

  // Start opens the guided task form pre-filled from the card; starting it links a run and moves the item.
  await page.getByRole("button", { name: "Start Inspect the sign-in flow", exact: true }).first().click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/plays\?originKind=work-item&originId=/);
  await expect(page.getByLabel(/^Situation/)).toHaveValue(/Inspect the sign-in flow/);
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.waitForURL(/\/runs\//);
  await expect.poll(() => states(w, missionId)["inspect"]).toBe("in-progress");
  expect(linkedRuns(w, missionId, "inspect")).toHaveLength(1);
  expect(errors).toEqual([]);
});
