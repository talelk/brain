import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const DIGEST = `sha256:${"c".repeat(64)}`;

/**
 * The mission's work as Timeline, Board and List (#43 plan tab). The board
 * offers a drag only for transitions the Governor accepts as plain moves
 * (in progress → review, review → in progress); a ready card does not lift
 * (Start dispatches), and the card menu lists exactly the legal moves.
 */
async function boardWorld(page: Page, governor: { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Kanban organization");
  await page.getByLabel(/^Email/).fill("kanban@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-kanban", slug: "kanban" });
  const ws = brain.store.workspaceDb("ws-kanban", actor.organizationId);
  const now = Date.now();
  const tasks = [
    { id: "draft", title: "Draft the rollout notes", criteria: ["c"], dependsOn: [], estimatedMinutes: 30, assignment: { kind: "agent", id: "writer", role: "specialist" } },
    { id: "build", title: "Build the release candidate", criteria: ["c"], dependsOn: [], estimatedMinutes: 90 },
    { id: "check", title: "Check the release candidate", criteria: ["c"], dependsOn: ["build"], estimatedMinutes: 20 },
    { id: "publish", title: "Publish the release", criteria: ["c"], dependsOn: ["check", "draft"], estimatedMinutes: 10 },
    { id: "legal", title: "Clear the legal review", criteria: ["c"], dependsOn: [] },
    { id: "kickoff", title: "Kick off the release", criteria: ["c"], dependsOn: [] },
  ];
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-kanban','Ship the release','Ship it','[\"c\"]','owner',?,?)").run(now, now);
  ws.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,team_json,created_at_ms) VALUES ('plan-kanban','obj-kanban',1,?,'confirmed','manual','owner',?,?,?)")
    .run(DIGEST, JSON.stringify(tasks), JSON.stringify([{ memberId: "writer", role: "Release writer", agentId: "writer-agent", engine: "fixture" }]), now);
  ws.prepare("UPDATE missions SET active_plan_version_id='plan-kanban' WHERE id='obj-kanban'").run();
  const states: Record<string, string> = { draft: "ready", build: "in-progress", check: "review", publish: "backlog", legal: "blocked", kickoff: "done" };
  for (const task of tasks) {
    ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,blocked_reason,assignment_json,evidence_digest,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,'[\"c\"]','Next',?,?,?,?,?)")
      .run(`wi-${task.id}`, "obj-kanban", "plan-kanban", task.id, task.title, states[task.id], task.id === "legal" ? "Waiting for counsel" : null, task.assignment ? JSON.stringify(task.assignment) : null, states[task.id] === "done" ? DIGEST : null, now, now);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) ws.prepare("INSERT INTO work_item_dependencies(work_item_id,depends_on_work_item_id) VALUES (?,?)").run(`wi-${task.id}`, `wi-${dependency}`);
  const state = (id: string) => (ws.prepare("SELECT state FROM work_items WHERE id=?").get(id) as { state: string }).state;
  return { state };
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

test("mission board: legal drags move work, illegal ones stay buttons, the timeline shows the critical path", async ({ page, governor }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { state } = await boardWorld(page, governor);

  // Timeline (default): stages, the critical path and the plain-language overview.
  await page.goto(`${governor.url}/missions/obj-kanban/plan?w=ws-kanban`);
  const roadmap = page.getByTestId("work-roadmap").last();
  await expect(roadmap.getByRole("button", { name: "Manage Build the release candidate", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(roadmap.locator('[data-roadmap-node="wi-build"]').getByText("Critical path")).toBeVisible();
  await expect(roadmap.locator('[data-roadmap-node="wi-draft"]').getByText("Critical path")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Mission work at a glance" }).getByText("3 tasks in a row")).toBeVisible();
  await expect(roadmap.getByText("Release writer (writer)")).toBeVisible();

  // Board: five columns; the view is carried in the URL.
  await page.getByRole("radio", { name: "Board" }).click();
  await expect(page).toHaveURL(/view=board/);
  const board = page.getByTestId("work-board");
  for (const name of ["Ready", "In progress", "Review", "Blocked", "Done"]) await expect(board.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(board.locator('[data-kanban-column="ready"]').getByText("Publish the release")).toBeVisible();
  await expect(board.locator('[data-kanban-id="wi-draft"] [data-draggable]')).toHaveAttribute("data-draggable", "false");
  await expect(board.locator('[data-kanban-id="wi-build"] [data-draggable]')).toHaveAttribute("data-draggable", "true");

  if ((info.project.use.viewport?.width ?? 1440) >= 1024) {
    // A legal drag: in progress → review is a plain governed transition.
    await drag(page, "wi-build", "review");
    await expect.poll(() => state("wi-build")).toBe("review");
    await expect(board.locator('[data-kanban-column="review"] [data-kanban-id="wi-build"]')).toBeVisible();
    // A ready card does not lift: dragging it to Done changes nothing.
    await drag(page, "wi-draft", "done");
    await page.waitForTimeout(500);
    expect(state("wi-draft")).toBe("ready");
    await expect(page.locator("[data-kanban-dragging]")).toHaveCount(0);
  } else {
    await board.getByRole("button", { name: "Move Build the release candidate", exact: true }).click();
    await page.getByRole("menuitem", { name: "Review", exact: true }).click();
    await expect.poll(() => state("wi-build")).toBe("review");
  }

  // The keyboard path: the card menu offers exactly the legal moves (review → in progress), never Done.
  await board.getByRole("button", { name: "Move Check the release candidate", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Done", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
  await expect.poll(() => state("wi-check")).toBe("in-progress");
  // A ready card has no move menu at all; Start is its action and opens the dispatch flow.
  await expect(board.getByRole("button", { name: "Move Draft the rollout notes", exact: true })).toHaveCount(0);

  // Work others wait on offers Hand off (not Review) and opens the hand-off sheet on the item; List shows the same work.
  await expect(board.locator('[data-kanban-id="wi-build"]').getByText("Hand-off due")).toBeVisible();
  await board.getByRole("button", { name: "Hand off Build the release candidate", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel(/^What was done/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Back to mission work", exact: true })).toBeVisible();
  await expect(page.getByText("Evidence required for Done", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to mission work", exact: true }).click();
  await page.getByRole("radio", { name: "List" }).click();
  await expect(page.getByRole("list", { name: "Work items" }).getByText("Blocked: Waiting for counsel")).toBeVisible();

  await page.getByRole("radio", { name: "Board" }).click();
  await board.getByRole("button", { name: "Start Draft the rollout notes", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/plays\?originKind=work-item&originId=wi-draft/);
  expect(errors).toEqual([]);
});
