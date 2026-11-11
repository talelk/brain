import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { fixtureStarter } from "../support/starter";
import { sha256Digest } from "../../packages/contracts/src/index.ts";
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
  await page.getByLabel(/^Organization name/).fill("Context organization");
  await page.getByLabel(/^Email/).fill("ctx@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-ctx", slug: "ctx" });
  const bundle = fixtureStarter();
  // A small agent token ceiling gives the context pack a small budget so compaction is visible.
  const worker = bundle.documents.find((doc) => doc.path.endsWith("task-worker-agent.yaml"))!;
  const priorDigest = sha256Digest(new TextEncoder().encode(worker.text));
  const workerDoc = JSON.parse(worker.text);
  workerDoc.spec.maxTokens = 1000;
  worker.text = JSON.stringify(workerDoc, null, 2) + "\n";
  const nextDigest = sha256Digest(new TextEncoder().encode(worker.text));
  for (const doc of bundle.documents) doc.text = doc.text.replaceAll(priorDigest, nextDigest);
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-ctx")).actor;
  const sessions: RunnerSession[] = [];
  for (const group of ["agents", "evaluators"]) {
    const cfg = { governorUrl: governor.url, runnerId: `ctx-${group}`, stateDir: join(brain.store.dataDir, group), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const hello = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(actor, group).token);
    sessions.push({ cfg, sessionToken: hello.sessionToken, epoch: hello.epoch });
  }
  const ws = brain.store.workspaceDb("ws-ctx", actor.organizationId);
  return { brain, actor: scoped, ws, sessions };
}

type World = Awaited<ReturnType<typeof world>>;
const states = (w: World, missionId: string) => Object.fromEntries((w.ws.prepare("SELECT plan_task_id AS t, state AS s FROM work_items WHERE mission_id=? AND state!='abandoned'").all(missionId) as { t: string; s: string }[]).map((row) => [row.t, row.s]));

/** Creates the mission in the New mission form (describe path) and returns its id. */
async function createMission(page: Page, w: World, base: string, sentence: string, manual: boolean): Promise<string> {
  await page.goto(`${base}/w/ws-ctx/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill(sentence);
  if (manual) {
    await form.getByText("More options", { exact: true }).click();
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
  const key = `ctx-plan-${missionId}`;
  const { receipt } = await w.brain.executeCommand(w.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-ctx", idempotencyKey: key,
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



test("Context received tab shows the sections an agent was given, what was shortened, and the full text on request (#81)", async ({ page, governor }) => {
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
  await driveRuns(w, () => states(w, missionId)["inspect"] === "done");
  await expect.poll(() => states(w, missionId)["verify"]).toBe("in-progress");
  // A long note to the second task: a claim that is too big for its small context budget.
  const longNote = `Please prefer the venue closest to the station. ${"The team travels by train and every extra minute on foot costs the offsite goodwill. ".repeat(40)}Final reminder: book by Friday.`;
  const verifyItem = w.ws.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='verify'").get(missionId) as { id: string };
  const sent = await w.brain.executeCommand(w.actor, { contractVersion: "brain.command/v1", commandId: "cmd-ctx-note", commandType: "mission.message.send", workspaceId: "ws-ctx", idempotencyKey: "ctx-note", payload: { missionId, recipient: { kind: "mission" }, workItemId: verifyItem.id, body: longNote } } as never, "ctx-note");
  expect(sent.receipt.accepted).toBe(true);
  await expect.poll(async () => { for (const session of w.sessions.slice(0, 1)) await runOnce(session.cfg, session.sessionToken, session.epoch); return w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM artifact_associations WHERE artifact_id LIKE 'ctx-job%'").get(); }, { timeout: 30_000 }).toEqual({ n: 2 });
  const verifyRun = (w.ws.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").get(verifyItem.id) as { run_id: string }).run_id;
  const verifyJob = (w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(verifyRun) as { id: string }).id;
  await page.goto(`${governor.url}/runs/${encodeURIComponent(verifyJob)}?tab=context`);
  await expect(page.getByRole("radio", { name: "Context received" })).toBeChecked();
  const panel = page.getByRole("region", { name: "Context this task received" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-context-total]")).toContainText("(estimated)");
  for (const section of ["brief", "handoff-facts", "messages"]) await expect(panel.locator(`[data-section="${section}"]`)).toBeVisible();
  await expect(panel.locator('[data-section="messages"]')).toContainText("Claim: written by a person or an agent, not verified");
  const cut = panel.locator("[data-truncation]").first();
  await expect(cut).toContainText("A message sent to this task");
  await expect(panel).toContainText("No model wrote a summary");
  if (shots) await page.screenshot({ path: `${shots}/ctx-1-panel.png`, fullPage: true });
  await cut.getByRole("button", { name: "Show the full text" }).click();
  await expect(cut.locator("[data-reference-text]")).toContainText("Final reminder: book by Friday.");
  if (shots) await page.screenshot({ path: `${shots}/ctx-2-full-text.png`, fullPage: true });
  expect(errors).toEqual([]);
});
