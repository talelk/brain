import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { fixtureStarter } from "../support/starter";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";

/**
 * Fresh install, as a first-time administrator (#48, AF-12 verify): Today blocks the box and lists what is
 * missing; each fix completes without a reload; then the sample goal runs a real mission on the shipped
 * workflow to a verified result, which is how the install proves itself end to end.
 */
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

/** The first-run check as a first-time user does it: one click on Today, no navigation, plain words, the checklist folds on a pass. */
async function runTheCheck(page: Page, row: (step: string) => Locator, finish: () => Promise<void>, button = "Run the check"): Promise<void> {
  const todayUrl = page.url();
  const setup = page.getByTestId("today-setup");
  await row("smoke").getByRole("button", { name: button, exact: true }).click();
  await expect(row("smoke")).toHaveAttribute("data-phase", /starting|running/);
  await expect(row("smoke").getByTestId("check-detail")).toContainText(/Starting the check|Running the check/);
  expect(page.url()).toBe(todayUrl);
  await finish();
  const done = page.getByTestId("today-setup-done");
  await expect(done).toContainText("Brain works: start your first mission", { timeout: 30_000 });
  await expect(done).toContainText(/The check passed in \d+( min \d+)? s\./);
  await expect(setup).toHaveCount(0);
  expect(page.url()).toBe(todayUrl);
  await expect(page.locator("body")).not.toContainText(/Raw JSON|durable acceptance|independent verification remain/);
}

test("a fresh install is blocked with a checklist, each fix completes it without a reload, and the sample goal reaches a verified result", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const startedAt = Date.now();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "fresh");
  brain.createWorkspace(actor, { workspaceId: "ws-fresh", slug: "fresh" });
  const setup = page.getByTestId("today-setup");
  const row = (step: string) => setup.locator(`[data-step="${step}"]`);

  // Nothing is installed: the box is blocked and the release is the missing item.
  await page.goto(`${governor.url}/w/ws-fresh/today`);
  await expect(setup).toBeVisible({ timeout: 30_000 });
  await expect(row("release")).toHaveAttribute("data-status", "missing");
  await expect(page.getByLabel(/^What do you want done/)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Try a sample goal", exact: true })).toBeDisabled();
  await expect(page.getByText("Blocked until the setup below is done.")).toBeVisible();
  await shot(page, "install-blocked");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "install-blocked");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The release fix opens the existing release screen.
  await row("release").getByRole("button", { name: "Install the starter kit", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=release/);
  await page.goBack();

  // An administrator activates the starter release elsewhere; the checklist follows without a reload and now asks for runners.
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  await expect(row("release")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await expect(row("runners")).toHaveAttribute("data-status", "missing");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();

  // Runners come online: the box opens, and the one thing left is to run the check.
  const sessions = await enrollRunners(governor, actor, "fresh", ["agents", "evaluators"]);
  await expect(row("runners")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await expect(page.getByLabel(/^What do you want done/)).toBeEnabled();
  await expect(row("smoke")).toHaveAttribute("data-status", "unverified");
  await expect(setup).toContainText("One more step");
  await shot(page, "install-ready-to-try");

  // One click on "Run the check": the page stays on Today, the row shows the progress, and a pass folds the checklist into one line.
  const ws = brain.store.workspaceDb("ws-fresh", actor.organizationId);
  const checkRun = () => (ws.prepare("SELECT r.state FROM workflow_runs r JOIN run_inputs i ON i.run_id=r.id WHERE json_extract(i.workflow_json,'$.metadata.id')='agent-smoke' ORDER BY r.created_at_ms DESC LIMIT 1").get() as { state: string } | undefined)?.state;
  await runTheCheck(page, row, () => driveRuns(sessions, () => checkRun() === "succeeded", 60_000));
  await shot(page, "install-check-passed");

  // The sample goal starts a real mission on the shipped workflow.
  await page.getByRole("button", { name: "Try a sample goal", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-fresh")).actor;
  const mission = ws.prepare("SELECT id, title, auto_start FROM missions").get() as { id: string; title: string; auto_start: number };
  expect(mission.title).toBe("Sample goal: check this install");
  expect(mission.auto_start).toBe(1);
  // The planner's proposal is the one direct write (the "ask Brain" step); everything after it is the product.
  const key = "fresh-plan";
  const { receipt } = await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-fresh", idempotencyKey: key,
    payload: { missionId: mission.id, origin: "manual", summary: "Write the note", tasks: [{ id: "note", title: "Write the sample note", criteria: ["structure", "safety"], dependsOn: [], workflowId: "x" }] },
  } as never, key);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(mission.id, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(mission.id)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();

  await driveRuns(sessions, () => (ws.prepare("SELECT state FROM missions WHERE id=?").get(mission.id) as { state: string }).state === "closed", 90_000);
  expect(ws.prepare("SELECT state, outcome FROM missions WHERE id=?").get(mission.id)).toEqual({ state: "closed", outcome: "achieved" });

  // The verified result is readable, with how it was checked.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(mission.id)}/outputs`);
  const card = page.getByTestId("mission-result").filter({ hasText: "Write the sample note" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  if ((await card.getAttribute("data-open")) !== "true") await card.getByRole("button", { name: /Write the sample note/ }).click();
  await expect(card.getByTestId("result-reader").getByTestId("trust-line")).toContainText("checked by tests, files or hashes", { timeout: 30_000 });
  await shot(page, "install-sample-verified");
  // Empty install to the first verified result in under five minutes (Phase 2 gate): the whole path above, from the blocked box to the readable result.
  expect(Date.now() - startedAt).toBeLessThan(5 * 60_000);
  expect(errors).toEqual([]);
});

test("a check that cannot start says why in plain words, offers one next step, and passes when run again", async ({ page, governor }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { brain, actor } = await signUpOwner(page, governor, "retry");
  brain.createWorkspace(actor, { workspaceId: "ws-retry", slug: "retry" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const sessions = await enrollRunners(governor, actor, "retry", ["agents", "evaluators"]);
  const ws = brain.store.workspaceDb("ws-retry", actor.organizationId);
  const checkRun = () => (ws.prepare("SELECT r.state FROM workflow_runs r JOIN run_inputs i ON i.run_id=r.id WHERE json_extract(i.workflow_json,'$.metadata.id')='agent-smoke' ORDER BY r.created_at_ms DESC LIMIT 1").get() as { state: string } | undefined)?.state;
  await page.goto(`${governor.url}/w/ws-retry/today`);
  const row = (step: string) => page.getByTestId("today-setup").locator(`[data-step="${step}"]`);
  await expect(row("smoke")).toHaveAttribute("data-status", "unverified", { timeout: 30_000 });
  await page.route("**/v1/tasks/drafts", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "No model is connected." }) }));
  await row("smoke").getByRole("button", { name: "Run the check", exact: true }).click();
  await expect(row("smoke")).toHaveAttribute("data-phase", "failed");
  await expect(row("smoke").getByTestId("check-detail")).toContainText("The check could not start. No model is connected.");
  await expect(row("smoke").getByTestId("check-next")).toContainText("Next step: make sure the model answers, then run the check again.");
  expect(page.url()).toContain("/today");
  await page.unroute("**/v1/tasks/drafts");
  await runTheCheck(page, row, () => driveRuns(sessions, () => checkRun() === "succeeded", 60_000), "Run the check again");
});

test("on a phone the check is also one click on Today, in place, and the page does not scroll sideways", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  const { brain, actor } = await signUpOwner(page, governor, "phone");
  brain.createWorkspace(actor, { workspaceId: "ws-phone", slug: "phone" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const sessions = await enrollRunners(governor, actor, "phone", ["agents", "evaluators"]);
  const ws = brain.store.workspaceDb("ws-phone", actor.organizationId);
  const checkRun = () => (ws.prepare("SELECT r.state FROM workflow_runs r JOIN run_inputs i ON i.run_id=r.id WHERE json_extract(i.workflow_json,'$.metadata.id')='agent-smoke' ORDER BY r.created_at_ms DESC LIMIT 1").get() as { state: string } | undefined)?.state;
  await page.goto(`${governor.url}/w/ws-phone/today`);
  const row = (step: string) => page.getByTestId("today-setup").locator(`[data-step="${step}"]`);
  await expect(row("smoke")).toHaveAttribute("data-status", "unverified", { timeout: 30_000 });
  await shot(page, "install-phone-ready");
  await runTheCheck(page, row, () => driveRuns(sessions, () => checkRun() === "succeeded", 60_000));
  await shot(page, "install-phone-passed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // The task's own page stays, in plain words: the agent is named once under Team roles.
  await page.goto(`${governor.url}/plays/agent-smoke`);
  const roles = page.locator("section").filter({ has: page.getByRole("heading", { name: "Team roles", exact: true }) });
  await expect(roles).toBeVisible({ timeout: 30_000 });
  await expect(roles.getByRole("button")).toHaveCount(1);
  expect((await roles.getByRole("button").innerText()).match(/Diagnostic/giu)).toHaveLength(1);
  await expect(page.locator("body")).not.toContainText(/Raw JSON|durable acceptance|independent verification remain/);
  expect(errors).toEqual([]);
});
