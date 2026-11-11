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

/** The manual-mode Start: the guided task form pre-filled from the card. */
async function startFromCard(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: `Start ${title}`, exact: true }).first().click();
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.waitForURL(/\/runs\//);
}

test("mission flow (auto): create, confirm, tasks start by themselves, run, verified Done by itself, dependents unlock, finish", async ({ page, governor }) => {
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

  // The runners finish the run; the verified evidence completes the task by itself (handoff written by the Governor),
  // the dependent starts, finishes and completes the same way. No person touches evidence or handoffs.
  await driveRuns(w, () => states(w, missionId)["inspect"] === "done");
  expect((w.ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runs[0]) as { state: string }).state).toBe("succeeded");
  expect((w.ws.prepare("SELECT submitted_by FROM handoffs WHERE superseded_by IS NULL").get() as { submitted_by: string }).submitted_by).toBe("governor");
  await expect.poll(() => states(w, missionId)["verify"]).toBe("in-progress");
  expect(linkedRuns(w, missionId, "verify")).toHaveLength(1);
  await driveRuns(w, () => states(w, missionId)["verify"] === "done");
  // Nobody presses Finish: the Governor proposes completion, records the verdict over the complete bundle and closes as achieved.
  await expect.poll(() => w.ws.prepare("SELECT state, outcome FROM missions WHERE id=?").get(missionId), { timeout: 30_000 }).toEqual({ state: "closed", outcome: "achieved" });
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

test("outputs (bulk): Request changes sends the task back, Accept explains the handoff other tasks need", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await world(page, governor);
  // "Ask me before each task": the person starts the task and reviews its result (nothing completes it by itself).
  const missionId = await createMission(page, w, governor.url, "Check the billing export carefully", true);
  await proposePlan(w, missionId, "Inspect, then verify the export");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => states(w, missionId)).toEqual({ inspect: "ready", verify: "backlog" });
  await startFromCard(page, "Inspect the sign-in flow");
  await expect.poll(() => states(w, missionId)["inspect"]).toBe("in-progress");
  await driveRuns(w, () => states(w, missionId)["inspect"] === "review");

  // The finished task's output is a file waiting for review. Bulk Accept refuses to close work other
  // tasks depend on until it is handed off, and a file without an independent check is refused with its reason.
  await page.goto(`${governor.url}/w/ws-flow/outputs?folder=review`);
  // One Result per task leads; run records and data files stay collapsed under "Technical files".
  await expect(page.getByRole("button", { name: "Preview Result: Inspect the sign-in flow" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("output-technical")).toHaveCount(1);
  await expect(page.getByTestId("output-technical").getByText(/^Technical files \(\d+\)/)).toBeVisible();
  await page.getByRole("checkbox", { name: /^Select / }).first().check({ timeout: 30_000 });
  const selection = page.getByRole("region", { name: "Selection actions" });
  await expect(selection).toContainText("1 selected");
  await selection.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText(/Accepted 0 of 1\. .*Other tasks wait on it\. Open the file to hand off, then accept\./)).toBeVisible({ timeout: 30_000 });
  expect(states(w, missionId)["inspect"]).toBe("review");

  // Request changes sends the ticked file's task back with one reason.
  await page.getByRole("checkbox", { name: /^Select / }).first().check();
  await selection.getByRole("button", { name: "Request changes", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Please cover the refund lines too.");
  await page.getByRole("dialog").getByRole("button", { name: /^(Send back|Request changes)/ }).click();
  await expect(page.getByText(/Sent back 1 item\./)).toBeVisible({ timeout: 30_000 });
  // The task is ready again; the person starts a fresh run, then it returns to review.
  await expect.poll(() => states(w, missionId)["inspect"]).toBe("ready");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await startFromCard(page, "Inspect the sign-in flow");
  await expect.poll(() => linkedRuns(w, missionId, "inspect").length, { timeout: 60_000 }).toBe(2);
  await driveRuns(w, () => states(w, missionId)["inspect"] === "review");
  expect(errors).toEqual([]);
});
