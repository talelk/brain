import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { Brain } from "../../apps/governor/src/application/brain";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
interface GovernorFixture { url: string; credential: string; app: { brain: Brain } }

async function boardWorld(page: Page, governor: GovernorFixture) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Board organization");
  await page.getByLabel(/^Email/).fill("board@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-board", slug: "board" });
  const ws = brain.store.workspaceDb("ws-board", actor.organizationId);
  const now = Date.now();
  ws.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-ui','Fixture objective','Fixture intent','[\"echo\"]','owner',?,?)").run(now, now);
  ws.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-ui','obj-ui',1,?,'confirmed','manual','owner','[]',?)").run(DIGEST_A, now);
  return { brain, actor, ws };
}

function seedWorkItem(ws: ReturnType<Brain["store"]["workspaceDb"]>, id: string, title: string, state: string): void {
  const now = Date.now();
  ws.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES (?,'obj-ui','plan-ui',?,?,?,'[\"echo\"]',?,?,?)")
    .run(id, id, title, state, "Start this task", now, now);
}

async function openBoard(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work board", exact: true, level: 1 })).toBeVisible();
}

test("board: work items render by state, move applies, Done without evidence is refused in UI (T37)", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Board organization");
  await page.getByLabel(/^Email/).fill("board@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  brain.createWorkspace(actor, { workspaceId: "ws-board", slug: "board" });
  const ws = brain.store.workspaceDb("ws-board", actor.organizationId);
  const now = Date.now();
  ws.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-ui','Fixture objective','Fixture intent','[\"echo\"]','owner',?,?)").run(now, now);
  ws.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-ui','obj-ui',1,?,'confirmed','manual','owner','[]',?)").run(DIGEST_A, now);
  seedWorkItem(ws, "work-ui-1", "Ship the fixture", "ready");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work board", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Ship the fixture", { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/w/ws-board/board");

  await page.getByText("Manage Ship the fixture",{exact:true}).click();
  await page.getByLabel("Move Ship the fixture", { exact: true }).click();
  await page.getByRole("option", { name: "In Progress", exact: true }).click();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE id='work-ui-1'").get() as { state: string }).state).toBe("in-progress");
  await page.getByLabel("Move Ship the fixture", { exact: true }).click();
  await page.getByRole("option", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE id='work-ui-1'").get() as { state: string }).state).toBe("review");

  await page.getByLabel("Move Ship the fixture", { exact: true }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  // The refusal alert sits behind the open dialog for assistive tech; close the dialog to read it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toContainText(/evidence/i);
  expect((ws.prepare("SELECT state FROM work_items WHERE id='work-ui-1'").get() as { state: string }).state).toBe("review");
  expect(errors).toEqual([]);
});

test("board: Done succeeds with explicitly bound verified evidence (T37)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, ws } = await boardWorld(page, governor);
  seedWorkItem(ws, "work-ui-2", "Verify the fixture", "review");
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: "bundle-ui", organizationId: actor.organizationId, workspaceId: "ws-board",
    workflowRunId: "run-ui", jobId: "job-ui", attemptId: "att-ui", jobFence: 1,
    sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [],
    artifacts: [], checks: [{ criterionId: "echo", checkId: "c1", status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" }],
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?, 'bundle-ui', 'job-ui', 'att-ui', 'verified', ?, ?)").run(DIGEST_A, JSON.stringify(manifest), brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-ui', ?, 'eval-ui', ?, 'verified', '{}', ?)").run(DIGEST_A, DIGEST_A, brain.store.now());

  await openBoard(page);
  await expect(page.getByText("Verify the fixture", { exact: true })).toBeVisible();
  await page.getByText("Manage Verify the fixture",{exact:true}).click();
  await page.getByLabel("Verified evidence for Verify the fixture", { exact: true }).click();
  await page.getByRole("option", { name: /1 passed criteria/ }).click();
  await page.getByLabel("Move Verify the fixture", { exact: true }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE id='work-ui-2'").get() as { state: string }).state).toBe("done");
  await page.keyboard.press("Escape");
  await expect(page.getByText(/evidence attached/i)).toBeVisible();
  expect(errors).toEqual([]);
});

test("board: desktop drag and compact controls move a work item across columns (T37)", async ({ page, governor }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { ws } = await boardWorld(page, governor);
  seedWorkItem(ws, "work-drag-1", "Drag the fixture", "ready");
  await openBoard(page);
  if (info.project.name.startsWith("390")) {
    await page.getByText("Manage Drag the fixture", { exact: true }).click();
    await page.getByLabel("Move Drag the fixture", { exact: true }).click();
    await page.getByRole("option", { name: "In Progress", exact: true }).click();
    await page.getByRole("button", { name: "Move work item", exact: true }).click();
    await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE id='work-drag-1'").get() as { state: string }).state).toBe("in-progress");
    expect(errors).toEqual([]);
    return;
  }
  const card = page.locator("[data-kanban-id='work-drag-1']");
  await expect(card).toBeVisible();
  const from = await card.boundingBox();
  expect(from, "card has a box").toBeTruthy();
  // Drop over the In Progress column header area.
  const target = page.getByText("In Progress", { exact: true }).first();
  const to = await target.boundingBox();
  expect(to, "target column has a box").toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + 12);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 60, { steps: 24 });
  await page.mouse.up();
  await expect.poll(() => (ws.prepare("SELECT state FROM work_items WHERE id='work-drag-1'").get() as { state: string }).state, { timeout: 15_000 }).toBe("in-progress");
  expect(errors).toEqual([]);
  void info;
});
