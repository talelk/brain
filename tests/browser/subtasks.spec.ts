import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * Subtasks (#131), walked like a first-time user on the seeded Operations workspace: the board shows the parent and its subtask as two
 * cards that point at each other (never one card twice), the parent's page lists its subtasks with progress and cost, a person adds a
 * subtask in the plan editor, Done waits for the subtasks, and abandoning a parent is refused until the person takes its open subtasks
 * with it and says why.
 */
test("a person reads subtasks on the board, adds one in the plan, and abandons a parent together with them", async ({ page, governor }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const missionId = demo.seed.missionIds.active;
  const brain = governor.app.brain;
  const parentId = demo.seed.workItems["in-progress"];
  const childId = demo.seed.workItems["blocked"];

  await page.goto(`${governor.url}/missions/${missionId}/plan?w=operations`);
  await page.getByRole("radio", { name: "Board" }).click();
  const board = page.getByTestId("work-board");
  const parent = board.locator(`[data-work-item="${parentId}"]`);
  const child = board.locator(`[data-work-item="${childId}"]`);
  await expect(parent).toBeVisible({ timeout: 20_000 });

  // Two cards, one per item: the parent says how far its subtasks are, the subtask names its parent.
  await expect(parent.getByTestId("work-subtasks")).toContainText("0 of 1 subtasks done");
  await expect(child.getByTestId("work-parent")).toHaveText("Subtask of Reproduce the latency regression");
  await expect(board.getByText("Collect production traces", { exact: true })).toHaveCount(1);
  await expect(board.locator("[data-work-item]")).toHaveCount(6);

  // The parent's page: its subtasks, with progress and the cost of the whole.
  await parent.getByRole("button", { name: /^Manage /u }).click();
  const panel = page.getByTestId("work-subtasks-panel");
  await expect(panel.getByTestId("work-subtasks-progress")).toHaveText("0 of 1 subtasks done");
  await expect(panel.getByRole("list", { name: "Subtasks" })).toContainText("Collect production traces");
  await expect(panel.getByTestId("work-subtasks-cost")).toContainText("spent on this task and its subtasks together");
  // The Done rule is plain: it cannot be chosen without evidence, and the subtasks are part of the story.
  await expect(panel).toContainText("only when every subtask is Done");
  await panel.getByRole("button", { name: "Collect production traces", exact: true }).click();
  await expect(page.getByTestId("work-subtasks-panel")).toContainText("Part of");
  await page.getByTestId("work-subtasks-panel").getByRole("button", { name: "Reproduce the latency regression", exact: true }).click();

  // The Governor holds the rule even when a client asks: the parent is not Done while its subtask is open.
  const current = (await brain.executeQuery(demo.actor, { queryType: "workItems.get", workspaceId: demo.workspaceId, resourceId: parentId } as never)) as unknown as { snapshot: { version: number; state: string } };
  await expect(brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-sub-done", commandType: "workItem.transition", workspaceId: demo.workspaceId, idempotencyKey: "sub-done",
    expectedVersion: current.snapshot.version, payload: { workItemId: parentId, state: "review" },
  } as never, "sub-done")).resolves.toBeDefined();

  // Abandon the parent: refused while a subtask is open.
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel(/^Move /u).click();
  await page.getByRole("option", { name: "Abandoned", exact: true }).click();
  await expect(sheet.getByTestId("abandon-subtasks")).toContainText("Also abandon its 1 open subtasks");
  await sheet.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect(sheet).toContainText("still has 1 open subtask (Collect production traces)");
  // Take the subtask along: the reason is required and every subtask shows it.
  await sheet.getByLabel("Also abandon its 1 open subtasks").check();
  await expect(sheet.getByRole("button", { name: "Move work item", exact: true })).toBeDisabled();
  await sheet.getByLabel("Why? Each subtask shows this reason.").fill("The regression was fixed upstream");
  await sheet.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(board.locator("[data-work-item]")).toHaveCount(4);
  const dropped = (await brain.executeQuery(demo.actor, { queryType: "workItems.get", workspaceId: demo.workspaceId, resourceId: childId } as never)) as unknown as { snapshot: { state: string; nextAction: string } };
  expect(dropped.snapshot).toMatchObject({ state: "abandoned", nextAction: "Parent abandoned: The regression was fixed upstream" });
  expect(errors).toEqual([]);
});

test("a person adds a subtask in the plan editor and the board shows it under its parent", async ({ page, governor }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const missionId = demo.seed.missionIds.active;

  await page.goto(`${governor.url}/missions/${missionId}/plan?w=operations`);
  await page.getByRole("button", { name: /^See the confirmed plan's \d+ steps$/u }).click();
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  // The step that already is a subtask says so; "Add a subtask" offers a new empty step under a step of its own.
  await expect(sheet.getByRole("region", { name: "Step 4" }).getByTestId("plan-step-parent")).toContainText("Reproduce the latency regression");
  await sheet.getByRole("region", { name: "Step 3" }).getByRole("button", { name: "Add a subtask", exact: true }).click();
  const added = sheet.getByRole("region", { name: "Step 5" });
  await expect(added.getByTestId("plan-step-parent")).toContainText("Reproduce the latency regression");
  // An empty subtask cannot be kept: it needs an outcome and a way to tell it is done.
  await expect(sheet.getByTestId("plan-step-incomplete")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Keep edits", exact: true })).toBeDisabled();
  await added.getByLabel("Step 5 expected outcome").fill("Compare latency before and after the deploy");
  await added.getByLabel("Acceptance criteria").fill("A chart of p95 latency per hour is attached");
  await expect(sheet.getByTestId("plan-step-incomplete")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();

  await page.getByRole("radio", { name: "Board" }).click();
  const board = page.getByTestId("work-board");
  await expect(board.getByText("Compare latency before and after the deploy", { exact: true })).toHaveCount(1, { timeout: 20_000 });
  await expect(board.locator("[data-work-item]")).toHaveCount(7);
  await expect(board.locator(`[data-work-item="${demo.seed.workItems["in-progress"]}"]`).getByTestId("work-subtasks")).toContainText("0 of 2 subtasks done");
  expect(errors).toEqual([]);
});
