import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * Priority, tags and due date on work items (#116), walked like a first-time user on the seeded Operations workspace: read the board,
 * filter by tag, open a task, change its priority, tags and due date, and see the overdue flag clear. An overdue task is only flagged:
 * it never becomes a Needs-you item and nobody is notified.
 */
test("a person reads priority, tags and overdue on the board, filters by tag and edits a task's details", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const missionId = demo.seed.missionIds.active;
  const brain = governor.app.brain;
  const overdueId = demo.seed.workItems["ready"];

  // The mission's Plan tab, Board view.
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=operations`);
  await page.getByRole("radio", { name: "Board" }).click();
  const board = page.getByTestId("work-board");
  const checklist = board.locator(`[data-work-item="${overdueId}"]`);
  await expect(checklist).toBeVisible({ timeout: 20_000 });

  // Cards say priority, tags and due date; the overdue one is flagged in words, not only colour.
  await expect(checklist.getByTestId("work-priority")).toHaveText("Urgent");
  await expect(checklist.getByTestId("work-overdue")).toHaveText("Overdue: was due 15 Jan 2020");
  await expect(checklist.getByTestId("work-tag")).toHaveText("rollout");
  const latency = board.locator(`[data-work-item="${demo.seed.workItems["in-progress"]}"]`);
  await expect(latency.getByTestId("work-priority")).toHaveText("High");
  await expect(latency.getByTestId("work-due")).toHaveText("Due 12 Mar 2099");
  await expect(latency.getByTestId("work-overdue")).toHaveCount(0);
  await expect(board.getByTestId("work-overdue")).toHaveCount(1);

  // An overdue task is a board flag only: it raises no Needs-you item and no notification.
  const attention = (await brain.executeQuery(demo.actor, { queryType: "attention.list", workspaceId: demo.workspaceId } as never)) as unknown as { snapshot: { items: Array<{ kind: string; title: string; resourceId?: string }> } };
  expect(attention.snapshot.items.filter((item) => item.resourceId === overdueId || /overdue/iu.test(`${item.kind} ${item.title}`))).toEqual([]);
  const notices = (await brain.executeQuery(demo.actor, { queryType: "notifications.list", workspaceId: demo.workspaceId } as never)) as unknown as { snapshot: { items: Array<{ title?: string; kind?: string }> } };
  expect(notices.snapshot.items.filter((item) => /overdue/iu.test(`${item.kind ?? ""} ${item.title ?? ""}`))).toEqual([]);

  // Filter by tag: only the tagged cards stay; the filter is part of the address and clears again.
  const filter = page.getByTestId("work-tag-filter");
  await filter.getByRole("button", { name: "rollout", exact: true }).click();
  await expect(page).toHaveURL(/tag=rollout/);
  await expect(board.locator("[data-work-item]")).toHaveCount(2);
  await expect(checklist).toBeVisible();
  await filter.getByRole("button", { name: "docs", exact: true }).click();
  await expect(board.locator("[data-work-item]")).toHaveCount(1);
  await expect(checklist).toHaveCount(0);
  await filter.getByRole("button", { name: "All tags", exact: true }).click();
  await expect(board.locator("[data-work-item]")).toHaveCount(6);

  // Open the overdue task and change its details in the side sheet.
  await checklist.getByRole("button", { name: /^Manage /u }).click();
  const details = page.getByTestId("work-details");
  await expect(details.getByTestId("work-details-priority")).toHaveText("Urgent");
  await expect(details.getByText("Overdue: was due 15 Jan 2020")).toBeVisible();
  await details.getByRole("button", { name: "Edit details", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Priority", { exact: true }).click();
  await page.getByRole("option", { name: "Normal", exact: true }).click();
  await sheet.getByLabel("Tags", { exact: true }).fill("rollout, Ops, ops");
  await sheet.getByLabel("Due date", { exact: true }).fill("2099-05-01");
  await sheet.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(details.getByTestId("work-details-priority")).toHaveText("Normal");
  await expect(details.getByText("rollout, ops", { exact: true })).toBeVisible();
  await expect(details.getByText("1 May 2099")).toBeVisible();
  await expect(details.getByText(/^Overdue/u)).toHaveCount(0);

  // Back on the board the flag is gone and the new tag is a filter.
  await page.getByRole("button", { name: "Back to mission work", exact: true }).click();
  await expect(board.getByTestId("work-overdue")).toHaveCount(0);
  await expect(filter.getByRole("button", { name: "ops", exact: true })).toBeVisible();
  await expect(checklist.getByTestId("work-priority")).toHaveCount(0);

  // Priority never changes what Done needs: the task is not done and has no evidence bound.
  const after = (await brain.executeQuery(demo.actor, { queryType: "workItems.get", workspaceId: demo.workspaceId, resourceId: overdueId } as never)) as unknown as { snapshot: { state: string; priority: string; evidenceDigest?: string } };
  expect(after.snapshot).toMatchObject({ priority: "normal" });
  expect(after.snapshot.state).not.toBe("done");
  expect(after.snapshot.evidenceDigest).toBeUndefined();
  expect(errors).toEqual([]);
});
