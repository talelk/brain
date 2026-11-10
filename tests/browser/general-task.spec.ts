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
  const task = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, criteria: ["structure", "safety"], dependsOn, workflowId: "x" });
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


test("a plain-words mission runs on the general task workflow and shows a readable, verified result", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const shots = process.env["BRAIN_SHOTS"] ?? "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const w = await world(page, governor);
  const missionId = await createMission(page, w, governor.url, "Compare two venues for the team offsite", false);
  await proposePlan(w, missionId, "Inspect, then verify the correction");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => states(w, missionId)).toEqual({ inspect: "in-progress", verify: "backlog" });
  const runId = linkedRuns(w, missionId, "inspect")[0]!;
  expect((JSON.parse((w.ws.prepare("SELECT workflow_json FROM run_inputs WHERE run_id=?").get(runId) as { workflow_json: string }).workflow_json) as { metadata: { id: string } }).metadata.id).toBe("general-task");
  if (shots) await page.screenshot({ path: `${shots}/1-plan.png`, fullPage: true });
  await driveRuns(w, () => states(w, missionId)["inspect"] === "done");
  await expect.poll(() => states(w, missionId)["verify"]).toBe("in-progress");
  await driveRuns(w, () => states(w, missionId)["verify"] === "done");
  await expect.poll(() => w.ws.prepare("SELECT state, outcome FROM missions WHERE id=?").get(missionId), { timeout: 30_000 }).toEqual({ state: "closed", outcome: "achieved" });
  if (shots) {
    await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
    await page.screenshot({ path: `${shots}/2-mission-done.png`, fullPage: true });
    await page.goto(`${governor.url}/w/ws-flow/outputs`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/3-outputs.png`, fullPage: true });
    await page.getByText(/^Result /).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/4-result.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
