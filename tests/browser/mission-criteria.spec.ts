import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";

/**
 * ADR 0034 as a first-time user meets it: the mission page lists the mission's success criteria on every tab with Covered / Not
 * covered, the plan editor offers them per step, and a criterion becomes covered when the work serving it is done. The planner's
 * proposal row and the finished task are the only direct writes (the planner and the runner path are covered by mission-flow).
 */
test("success criteria: shown on every tab, linked to a step in the plan editor, covered when the work is done", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Criteria organization");
  await page.getByLabel(/^Email/).fill("criteria@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-crit", slug: "crit" });
  brain.activateRelease(actor, brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4").digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-crit")).actor;
  const ws = brain.store.workspaceDb("ws-crit", actor.organizationId);
  const criteria = page.getByTestId("mission-criteria");

  // A person starts a mission in plain words; the sentence becomes its first success criterion, listed at once and not yet served.
  await page.goto(`${governor.url}/w/ws-crit/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill("Compare the two hosting vendors");
  await form.getByText("More options", { exact: true }).click();
  await form.getByLabel("Starting tasks", { exact: true }).click();
  await page.getByRole("option", { name: "Ask me before each task", exact: true }).click();
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (ws.prepare("SELECT id FROM missions WHERE title LIKE 'Compare the two%'").get() as { id: string }).id;
  await expect(page.getByTestId("mission-criteria-summary")).toHaveText("0 of 1 success criterion covered");
  await expect(criteria.getByTestId("mission-criterion")).toHaveCount(1);
  await expect(criteria.getByTestId("mission-criterion").first()).toContainText("Done: Compare the two hosting vendors");
  await expect(criteria.getByTestId("mission-criterion").first()).toContainText("Not covered");
  await expect(criteria.getByTestId("mission-criterion").first()).toContainText("No task serves this yet");

  // Brain proposes a plan whose step names no criterion; the person ticks the criterion on the step in the plan editor and confirms.
  const key = "crit-plan";
  const { receipt } = await brain.executeCommand(scoped, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-crit", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary: "Compare, then recommend", tasks: [{ id: "compare", title: "Compare the vendors", criteria: ["Both vendors are compared"], dependsOn: [] }] } } as never, key);
  expect(receipt.accepted).toBe(true);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Compare, then recommend", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plan-step-serves")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Success criteria this step serves", { exact: true })).toBeVisible();
  await sheet.getByLabel("Done: Compare the two hosting vendors", { exact: true }).check();
  await sheet.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(page.getByTestId("plan-step-serves")).toContainText("Done: Compare the two hosting vendors");
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE mission_id=? AND state!='abandoned'").all(missionId) as { state: string }[]).map((row) => row.state)).toEqual(["ready"]);
  expect((ws.prepare("SELECT tasks_json FROM plan_versions WHERE state='confirmed' AND mission_id=?").get(missionId) as { tasks_json: string }).tasks_json).toContain('"criterionIds":["c1"]');

  // The page now says work serves the criterion and that it is not finished: not the same as no task serving it.
  await expect(criteria.getByTestId("mission-criterion").first()).toContainText("0 of 1 task serving it is done");
  await expect(page.getByTestId("mission-criteria-summary")).toHaveText("0 of 1 success criterion covered");
  await expect(criteria.getByTestId("mission-criterion").first()).not.toContainText("No task serves this yet");

  // The criteria are on every tab, and the work finishing covers the criterion.
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(`sha256:${"9".repeat(64)}`, missionId);
  for (const tab of ["", "/plan", "/outputs", "/brief"]) {
    await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}${tab}`);
    await expect(page.getByTestId("mission-criteria-summary")).toHaveText("1 of 1 success criterion covered");
    await expect(criteria.getByTestId("mission-criterion").first()).toHaveAttribute("data-state", "covered");
    await expect(criteria.getByTestId("mission-criterion").first()).toContainText("Covered");
  }
  expect(errors).toEqual([]);
});
