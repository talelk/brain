import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

type Governor = { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } };

/**
 * The board across missions (#118, stories 59-60), walked like a first-time owner: sign up, find Board under Missions,
 * see the work of two missions together, narrow it by mission, team member, priority and tag, open a card in its mission,
 * and find that Review and Done are never a plain move. The mission Plan tab opens on its own board with the timeline
 * one click away. Work is made through the commands the screens send; everything the person does goes through the app.
 */
async function world(page: Page, governor: Governor) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Board organization");
  await page.getByLabel(/^Email/).fill("board@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const owner = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(owner, { workspaceId: "ws-board", slug: "board" });
  const actor = (await brain.resolveActor(new Headers({ cookie }), "ws-board")).actor;
  let count = 0;
  const run = async (commandType: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const key = `board-${commandType}-${++count}`;
    const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: key, commandType, workspaceId: "ws-board", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    if (!receipt.accepted) throw new Error(`${commandType} was refused`);
    return receipt.resourceId ?? "";
  };
  const items = async () => ((await brain.executeQuery(actor, { queryType: "workItems.list", workspaceId: "ws-board", limit: 100 })) as unknown as { snapshot: { items: Array<{ workItemId: string; planTaskId: string; missionId: string; state: string; version: number }> } }).snapshot.items;
  const mission = async (title: string, tasks: Array<{ id: string; title: string; member: string; priority?: string; tags?: string[]; state?: "in-progress" | "review" }>) => {
    const missionId = await run("mission.create", { title, intent: title, successCriteria: ["Done well"], autoStart: false });
    const planId = await run("plan.propose", { missionId, origin: "manual", tasks: tasks.map((task) => ({ id: task.id, title: task.title, criteria: [`${task.id} verified`], dependsOn: [], assignment: { kind: "agent", id: task.member, role: "specialist" } })) });
    const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId: "ws-board", resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await run("plan.confirm", { planVersionId: planId }, version);
    for (const task of tasks) {
      const find = async () => (await items()).find((item) => item.missionId === missionId && item.planTaskId === task.id)!;
      if (task.priority || task.tags) await run("workItem.details.set", { workItemId: (await find()).workItemId, ...(task.priority ? { priority: task.priority } : {}), ...(task.tags ? { tags: task.tags } : {}) }, (await find()).version);
      if (task.state) await run("workItem.transition", { workItemId: (await find()).workItemId, state: "in-progress" }, (await find()).version);
      if (task.state === "review") await run("workItem.transition", { workItemId: (await find()).workItemId, state: "review" }, (await find()).version);
    }
    return missionId;
  };
  const website = await mission("Launch the website", [
    { id: "copy", title: "Write the announcement", member: "writer", priority: "urgent", tags: ["launch", "copy"], state: "in-progress" },
    { id: "design", title: "Design the home page", member: "designer", tags: ["launch", "visual"] },
    { id: "proof", title: "Proofread the announcement", member: "writer", priority: "high", tags: ["copy"], state: "review" },
  ]);
  const database = await mission("Migrate the database", [
    { id: "schema", title: "Draft the new schema", member: "builder", priority: "high", tags: ["infra"] },
    { id: "backfill", title: "Plan the backfill", member: "writer", priority: "low", tags: ["infra"] },
  ]);
  const state = async (planTaskId: string) => (await items()).find((item) => item.planTaskId === planTaskId)!.state;
  return { website, database, state };
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** A real pointer drag: press, travel past the 4px threshold in steps, release over the target column. */
async function drag(page: Page, cardId: string, column: string): Promise<void> {
  const card = page.locator(`[data-kanban-id="${cardId}"]`);
  await card.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const target = (await page.locator(`[data-kanban-column="${column}"]`).boundingBox())!;
  await page.mouse.move(from.x + 6, from.y + 6);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

test("board across missions: find it, filter it four ways, open a card in its mission, never move to Review or Done", async ({ page, governor }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { website, database, state } = await world(page, governor);
  const desktop = (info.project.use.viewport?.width ?? 1440) >= 1024;

  // A first-time owner opens Missions and finds the board beside Live and Schedules.
  await page.goto(`${governor.url}/w/ws-board/missions`);
  const toggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws-board\/board/);
  await expect(page.getByRole("heading", { name: "Board", exact: true, level: 1 })).toBeVisible();

  // Every open task of both missions is on it, each card naming its mission.
  const board = page.getByTestId("work-board");
  const count = page.getByTestId("board-count");
  await expect(count).toHaveText("5 of 5 tasks", { timeout: 20_000 });
  for (const name of ["Ready", "In progress", "Review", "Blocked", "Done"]) await expect(board.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(board.locator('[data-kanban-column="in-progress"]').getByText("Write the announcement")).toBeVisible();
  await expect(board.locator('[data-kanban-column="review"]').getByText("Proofread the announcement")).toBeVisible();
  await expect(board.locator('[data-kanban-column="ready"]').getByText("Draft the new schema")).toBeVisible();
  await expect(board.locator('[data-kanban-id]').filter({ hasText: "Draft the new schema" }).getByRole("link", { name: "Migrate the database", exact: true })).toBeVisible();
  await expect(board.locator('[data-kanban-id]').filter({ hasText: "Write the announcement" }).getByRole("link", { name: "Launch the website", exact: true })).toBeVisible();
  // The most urgent work leads its column: the urgent task before the plain one in Ready would show here; Ready holds the high-priority schema first.
  const ready = board.locator('[data-kanban-column="ready"] [data-work-item]');
  await expect(ready.first()).toContainText("Draft the new schema");

  // Mission: only that mission's tasks, and the choice is in the address.
  await choose(page, "Mission", "Migrate the database");
  await expect(count).toHaveText("2 of 5 tasks");
  await expect(page).toHaveURL(new RegExp(`mission=${database}`));
  await expect(board.getByText("Write the announcement")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(count).toHaveText("5 of 5 tasks");
  await expect(page).not.toHaveURL(/mission=/);

  // Team member: the writer's work across both missions.
  await choose(page, "Team member", "writer");
  await expect(count).toHaveText("3 of 5 tasks");
  await expect(board.getByText("Plan the backfill")).toBeVisible();
  await expect(board.getByText("Draft the new schema")).toHaveCount(0);

  // Priority and tag narrow it further; a tag still lists the options the work offers, not only the ones left.
  await choose(page, "Priority", "Urgent");
  await expect(count).toHaveText("1 of 5 tasks");
  await expect(board.getByText("Write the announcement")).toBeVisible();
  await choose(page, "Priority", "Any priority");
  await choose(page, "Tag", "copy");
  await expect(count).toHaveText("2 of 5 tasks");
  await page.getByLabel("Tag", { exact: true }).click();
  await expect(page.getByRole("option", { name: "infra", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Filters that match nothing say so, and one click brings the whole board back.
  await choose(page, "Priority", "Low");
  await expect(page.getByTestId("board-none")).toContainText("No task matches these filters");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(count).toHaveText("5 of 5 tasks");

  // A reload keeps a filter: it is in the address.
  await page.goto(`${governor.url}/w/ws-board/board?tag=infra`);
  await expect(count).toHaveText("2 of 5 tasks", { timeout: 20_000 });
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(count).toHaveText("5 of 5 tasks");

  // Review and Done are never a plain move. The menu of a task in progress offers Ready only; a task in review offers In progress only.
  await board.getByRole("button", { name: "Move Write the announcement", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Ready", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Review", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Done", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await board.getByRole("button", { name: "Move Proofread the announcement", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "In progress", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Done", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  if (desktop) {
    // Dragging a card to Review or Done does nothing but say why.
    await drag(page, (await cardId(page, "Write the announcement")), "review");
    await expect(page.getByRole("status").filter({ hasText: "Review comes from a run submitting its evidence" })).toBeVisible();
    await drag(page, (await cardId(page, "Write the announcement")), "done");
    await page.waitForTimeout(400);
    expect(await state("copy")).toBe("in-progress");
    await expect(board.locator('[data-kanban-column="in-progress"]').getByText("Write the announcement")).toBeVisible();
  }
  // A move that is allowed goes through the Governor, whichever mission the card belongs to.
  await board.getByRole("button", { name: "Move Write the announcement", exact: true }).click();
  await page.getByRole("menuitem", { name: "Ready", exact: true }).click();
  await expect.poll(() => state("copy")).toBe("ready");
  await expect(board.locator('[data-kanban-column="ready"]').getByText("Write the announcement")).toBeVisible();

  // A card opens in its mission, on the task.
  await board.getByRole("button", { name: "Manage Draft the new schema", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${database}/plan\\?.*item=`));
  await expect(page.getByRole("button", { name: "Back to mission work", exact: true })).toBeVisible();

  // The Plan tab opens on the mission's own board, with the timeline one click away.
  await page.goto(`${governor.url}/missions/${website}/plan?w=ws-board`);
  await expect(page.getByTestId("work-board")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Mission work by round" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/view=timeline/);
  await expect(page.getByRole("list", { name: "Mission work by round" })).toBeVisible();
  await page.getByRole("radio", { name: "Board" }).click();
  await expect(page.getByTestId("work-board")).toBeVisible();
  expect(errors).toEqual([]);
});

async function cardId(page: Page, title: string): Promise<string> {
  return (await page.locator("[data-kanban-id]").filter({ hasText: title }).first().getAttribute("data-kanban-id"))!;
}
