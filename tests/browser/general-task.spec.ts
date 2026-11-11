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

/**
 * Readable logs over a real finished run: a model's streamed answer arrives as
 * mid-word chunks (with a structured payload and repeated generic lines mixed
 * in), and the page must show one message per turn, counted repeats, and every
 * line under its task's header with a one-line status.
 */
async function readableLogs(page: Page, w: World, base: string, missionId: string, shots: string): Promise<void> {
  const item = w.ws.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='inspect'").get(missionId) as { id: string };
  w.ws.prepare("INSERT INTO sessions(id, job_id, attempt_id, engine_id, adapter_digest, engine_features, state, event_sequence, updated_at_ms, work_item_id) VALUES ('ses-narr',NULL,NULL,'fixture',?, '[\"sessions\"]','running',0,?,?)")
    .run(`sha256:${"0".repeat(64)}`, Date.now(), item.id);
  const insert = w.ws.prepare("INSERT INTO events(event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?)");
  const digest = `sha256:${"b".repeat(64)}`;
  const now = Date.now();
  const long = "The guide covers two days of onboarding for the new team members, with an example command for each tool and a short check at the end of each section so nobody falls behind. ";
  const chunks = [
    "ution:** Day 2 includes an example command", " and the first walkthrough.\n\n", long, long.slice(0, 60),
  ];
  let seq = 1;
  const put = (type: string, body: unknown): void => { insert.run(`evt-narr-${seq}`, "session", "ses-narr", seq, type, JSON.stringify(body), digest, now + seq * 1000); seq += 1; };
  for (const text of chunks) put("text", { channel: "assistant", provisional: true, text });
  put("session.checkpointed", { sessionId: "ses-narr" });
  put("text", { channel: "assistant", provisional: true, text: "{\"draft\":\"Day 1 and Day 2\",\"criterion\":\"No step assumes" });
  put("text", { channel: "assistant", provisional: true, text: " prior setup\"}" });
  for (let i = 0; i < 3; i++) put("session.checkpointed", { sessionId: "ses-narr", n: i });

  // A tall viewport mounts the whole (virtualised) list at once.
  await page.setViewportSize({ width: 1440, height: 2800 });
  await page.goto(`${base}/w/ws-flow/logs`);
  const header = page.getByTestId("log-task-header").filter({ hasText: "Inspect the sign-in flow" });
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header.getByTestId("log-task-status")).toHaveText(/finished, verified/);
  // Chunks of one turn read as one message, never starting or ending mid-word.
  const said = page.getByTestId("log-sentence").filter({ hasText: "Day 2 includes an example command" });
  await expect(said).toHaveCount(1);
  expect((await said.textContent())!.length).toBeLessThan(260);
  await expect(page.getByTestId("log-sentence").filter({ hasText: "Brain delivered the draft" })).toHaveCount(1);
  await expect(page.getByTestId("log-sentence").filter({ hasText: /criterion|\{"/ })).toHaveCount(0);
  await expect(page.locator('[data-row-kind="repeat"]').filter({ hasText: /saved a checkpoint.*\d+ times/ })).toHaveCount(1);
  // Look at it: the task's header at the top of the list, nothing expanded yet.
  const headerTop = await header.evaluate((el) => { const ul = el.closest("ul") as HTMLElement; return (el.closest("li") as HTMLElement).getBoundingClientRect().top - ul.getBoundingClientRect().top + ul.scrollTop; });
  const toHeader = () => page.evaluate((top) => { (document.querySelector('[data-testid="log-list"] ul') as HTMLElement).scrollTop = top; }, headerTop);
  if (shots) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await toHeader();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/5-logs-1440.png` });
    await page.setViewportSize({ width: 1440, height: 2800 });
  }
  // The full text is one click away.
  await said.click();
  await expect(page.getByTestId("log-detail")).toContainText("with an example command for each tool");
  // Severity filter and search keep working on the aggregated rows.
  await page.getByLabel("Search retained logs (full text)").fill("walkthrough");
  await expect(page.getByTestId("log-sentence").filter({ hasText: "first walkthrough" })).toHaveCount(1, { timeout: 15_000 });
  await page.getByLabel("Search retained logs (full text)").fill("");
  // A header folds its task's entries away and shows them again.
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(said).toHaveCount(0);
  await header.click();
  await expect(said).toHaveCount(1);
  // Raw stays the raw record view.
  await page.getByRole("button", { name: "raw", exact: true }).click();
  await expect(page.getByTestId("log-task-header")).toHaveCount(0);
  await page.getByRole("button", { name: "readable", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await toHeader();
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/5-logs-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await readableLogs(page, w, governor.url, missionId, shots);
  if (shots) {
    await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
    await page.screenshot({ path: `${shots}/2-mission-done.png`, fullPage: true });
  }
  // The mission's own Outputs tab leads with one Result per task and reads the deliverable as a document.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs`);
  const cards = page.getByTestId("mission-result");
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText("No outputs yet")).toHaveCount(0);
  await expect(page.getByText(/named outputs/i)).toHaveCount(0);
  const first = cards.filter({ hasText: "Inspect the sign-in flow" });
  await first.getByRole("button", { name: /Inspect the sign-in flow/ }).click();
  const reader = first.getByTestId("result-reader");
  await expect(reader.getByRole("heading", { name: "Inspect the sign-in flow", level: 3 })).toBeVisible({ timeout: 30_000 });
  await expect(reader.getByRole("heading", { name: "Findings", level: 4 })).toBeVisible();
  await expect(reader.getByRole("table")).toBeVisible();
  await expect(reader.getByRole("columnheader", { name: "Cost" })).toBeVisible();
  await expect(reader.getByRole("listitem").filter({ hasText: /^A nested detail$/ })).toBeVisible();
  await expect(reader.getByRole("region", { name: "Summary" })).toContainText("Fixture result for: Inspect the sign-in flow");
  await expect(reader.getByRole("region", { name: "Criteria" })).toContainText("2 of 2 met");
  await expect(reader.getByRole("region", { name: "Assumptions" })).toContainText("The brief is complete");
  await expect(reader.getByTestId("trust-line")).toContainText("4 of 4 criteria checked by tests, files or hashes; 0 by human sign-off; 0 by model opinion");
  await expect(reader.getByText('"deliverable"')).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Download .md" })).toBeVisible();
  // Every finished task reads its real verdict on the card header too, not "not checked yet" (the agent's indented reply and its normalised output differ by digest).
  for (const card of await cards.all()) await expect(card).toContainText("criteria checked by tests, files or hashes");
  await expect(page.getByText("Not independently checked yet")).toHaveCount(0);
  // Named-output versions live under their Result card; there is no second list of the same tasks.
  await expect(page.getByText("Documents with versions")).toHaveCount(0);
  await expect(first.getByTestId("version-history")).toContainText("1 version");
  // The read-only link is offered next to the challenge on a verified result.
  await expect(first.getByRole("button", { name: "Share a read-only link" })).toBeVisible();
  // A refresh that changes the data keeps the opened card open and the page where it was.
  const scrolled = await page.evaluate(() => { window.scrollTo(0, 120); return window.scrollY; });
  w.ws.prepare("UPDATE work_items SET next_action='Nothing further', version=version+1 WHERE mission_id=?").run(missionId);
  await page.waitForTimeout(17_000);
  await expect(first).toHaveAttribute("data-open", "true");
  await expect(first.getByTestId("result-reader")).toBeVisible();
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThan(40);
  await expect(page).toHaveURL(/outputs\?result=/);
  if (shots) await page.screenshot({ path: `${shots}/3-mission-outputs.png`, fullPage: true });
  // The workspace Outputs page opens the same Result as a document too.
  await page.goto(`${governor.url}/w/ws-flow/outputs`);
  await page.getByText(/^Result: Inspect the sign-in flow/).first().click();
  const preview = page.getByTestId("outputs-preview").getByTestId("result-reader");
  await expect(preview.getByRole("heading", { name: "Findings", level: 4 })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByTestId("trust-line")).toContainText("checked by tests, files or hashes");
  if (shots) await page.screenshot({ path: `${shots}/4-result.png`, fullPage: true });
  // "Result ready" in the bell opens the mission's Result directly, not a tab to hunt in.
  await page.goto(`${governor.url}/w/ws-flow/missions`);
  await page.getByRole("button", { name: /^Needs you/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Result ready.*\. Open$/ }).first().click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/outputs/);
  await expect(page.getByTestId("result-reader").first()).toBeVisible({ timeout: 30_000 });
  if (shots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs`);
    const phone = page.getByTestId("result-reader").first();
    await expect(phone).toBeVisible({ timeout: 30_000 });
    await phone.screenshot({ path: `${shots}/5-mobile.png` });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});
