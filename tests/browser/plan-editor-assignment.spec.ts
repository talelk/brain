import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";

/**
 * The plan editor changes who does each step and who is on the mission team (#119), as a first-time user meets it: the editor shows the
 * team and a "Assigned to" choice per step, a member that cannot take a step is listed with the reason, edits are summarised in plain
 * words, confirming makes one new plan version (plan and team together), and started work is never changed in place. The planner's
 * proposal row and the started work item are the only direct writes; every step the person takes goes through the screen.
 */
test("plan editor: reassign a step and grow the team, see why a member can't take a step, confirm one new version, started work stays", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Team organization");
  await page.getByLabel(/^Email/).fill("team@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-team", slug: "team" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-team")).actor;
  const ws = brain.store.workspaceDb("ws-team", actor.organizationId);

  // A person starts a mission in plain words.
  await page.goto(`${governor.url}/w/ws-team/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill("Summarise the vendor spreadsheet");
  await form.getByText("More options", { exact: true }).click();
  await form.getByLabel("Starting tasks", { exact: true }).click();
  await page.getByRole("option", { name: "Ask me before each task", exact: true }).click();
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (ws.prepare("SELECT id FROM missions WHERE title LIKE 'Summarise the vendor%'").get() as { id: string }).id;

  // Brain proposes a plan: a team of one writer, a first step that needs the spreadsheet tool, a second step that needs no tool.
  const key = "team-plan";
  const { receipt } = await brain.executeCommand(scoped, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-team", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary: "Read the sheet, then write it up",
      team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }],
      tasks: [
        { id: "read", title: "Read the vendor sheet", criteria: ["Every vendor row is read"], dependsOn: [], requiredTools: ["csv.query"], assignment: { kind: "agent", id: "writer", role: "specialist" } },
        { id: "write", title: "Write the summary", criteria: ["The summary names each vendor"], dependsOn: ["read"], assignment: { kind: "agent", id: "writer", role: "specialist" } },
      ] } } as never, key);
  expect(receipt.accepted).toBe(true);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Read the sheet, then write it up", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plan-team-line")).toContainText("writer (Writer)");

  // The editor lists the team, and each step says who it is assigned to.
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  const team = sheet.getByTestId("plan-team");
  await expect(team.getByTestId("plan-team-member")).toHaveCount(1);
  await expect(team.getByTestId("plan-team-member")).toContainText("Writer (writer)");
  await expect(team.getByTestId("plan-team-member")).toContainText("Task worker on fixture");
  await expect(sheet.getByTestId("plan-step-assignment")).toHaveCount(2);

  // The person adds a reviewer bound to the support analyst; the role is a label, so the id is made for them.
  await team.getByLabel("Role", { exact: true }).fill("Reviewer");
  await team.getByLabel("Agent", { exact: true }).click();
  await page.getByRole("option", { name: /Support analyst/ }).click();
  await team.getByRole("button", { name: "Add to team", exact: true }).click();
  await expect(team.getByTestId("plan-team-member")).toHaveCount(2);
  await expect(team.locator('[data-member-id="reviewer"]')).toContainText("Support analyst on fixture");

  // The reviewer has no spreadsheet tool: it is listed for step 1 with the reason and cannot be picked.
  await sheet.getByLabel("Step 1 assigned to", { exact: true }).click();
  const unfit = page.getByRole("option", { name: /Reviewer \(reviewer\)/ });
  await expect(unfit).toContainText("Not eligible: missing tools csv.query");
  await expect(unfit).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // Step 2 needs no tool, so the reviewer can take it. #93's checkboxes keep working in the same editor.
  await sheet.getByLabel("Step 2 assigned to", { exact: true }).click();
  await page.getByRole("option", { name: /Reviewer \(reviewer\)/ }).click();
  await sheet.getByLabel("Done: Summarise the vendor spreadsheet", { exact: true }).first().check();
  await sheet.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(page.getByTestId("plan-assignment-changes")).toContainText("Write the summary: Writer (writer) to Reviewer (reviewer)");
  await expect(page.getByTestId("plan-assignment-changes")).toContainText("Adds Reviewer (reviewer), support-analyst on fixture");
  await expect(page.getByTestId("plan-team-line")).toContainText("reviewer (Reviewer)");
  await expect(page.getByTestId("plan-step-serves")).toContainText("Done: Summarise the vendor spreadsheet");
  // Nothing has changed for the mission until the person confirms.
  expect((ws.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id=?").get(missionId) as { n: number }).n).toBe(1);

  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id=?").get(missionId) as { n: number }).n).toBe(2);
  await expect.poll(() => (ws.prepare("SELECT state FROM plan_versions WHERE mission_id=? ORDER BY revision DESC LIMIT 1").get(missionId) as { state: string }).state).toBe("confirmed");
  const confirmed = ws.prepare("SELECT tasks_json, team_json FROM plan_versions WHERE mission_id=? AND state='confirmed'").get(missionId) as { tasks_json: string; team_json: string };
  expect((JSON.parse(confirmed.team_json) as Array<{ memberId: string }>).map((member) => member.memberId)).toEqual(["writer", "reviewer"]);
  const tasks = JSON.parse(confirmed.tasks_json) as Array<{ id: string; assignment?: { id: string }; criterionIds?: string[] }>;
  expect(tasks.map((task) => [task.id, task.assignment?.id])).toEqual([["read", "writer"], ["write", "reviewer"]]);
  expect(tasks[0]?.criterionIds).toEqual(["c1"]);
  await expect.poll(() => (ws.prepare("SELECT plan_task_id, assignment_json FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY plan_task_id").all(missionId) as Array<{ plan_task_id: string; assignment_json: string }>).map((row) => [row.plan_task_id, (JSON.parse(row.assignment_json) as { id: string }).id])).toEqual([["read", "writer"], ["write", "reviewer"]]);

  // Work on step 1 starts. Its assignment and its member are now fixed; the unstarted step can still move.
  const read = ws.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='read' AND state!='abandoned'").get(missionId) as { id: string };
  brain.missions.linkExecution(scoped, "ws-team", read.id, "run-team-read");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "See the confirmed plan's 2 steps" }).click();
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const again = page.getByRole("dialog");
  await expect(again.getByLabel("Step 1 assigned to", { exact: true })).toBeDisabled();
  await expect(again.getByTestId("plan-step-started")).toContainText("Work on this step has started, so its assignment can't change.");
  await expect(again.locator('[data-member-id="writer"]')).toContainText("Has started work");
  await expect(again.locator('[data-member-id="writer"]').getByRole("button", { name: /Remove/ })).toHaveCount(0);
  await expect(again.locator('[data-member-id="reviewer"]')).toContainText("Assigned steps: 1");
  await again.getByLabel("Step 2 assigned to", { exact: true }).click();
  await page.getByRole("option", { name: /Writer \(writer\)/ }).click();
  await expect(again.locator('[data-member-id="reviewer"]').getByRole("button", { name: /Remove Reviewer/ })).toBeVisible();
  await again.locator('[data-member-id="reviewer"]').getByRole("button", { name: /Remove Reviewer/ }).click();
  await expect(again.getByTestId("plan-team-member")).toHaveCount(1);
  await again.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(page.getByTestId("plan-assignment-changes")).toContainText("Removes Reviewer (reviewer)");
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id=?").get(missionId) as { n: number }).n).toBe(3);
  const retained = ws.prepare("SELECT id, assignment_json FROM work_items WHERE mission_id=? AND plan_task_id='read' AND state!='abandoned'").get(missionId) as { id: string; assignment_json: string };
  expect(retained.id).toBe(read.id);
  expect((JSON.parse(retained.assignment_json) as { id: string }).id).toBe("writer");
  expect(errors).toEqual([]);
});
