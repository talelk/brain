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
  return { brain, actor, ws };
}

async function openBoard(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Board", exact: true, level: 1 })).toBeVisible();
}

test("board: cards render by state, move applies, Done without evidence is refused in UI (T37)", async ({ page, governor }) => {
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
  ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-ui-1', 'Ship the fixture', 'todo', '[\"echo\"]', 1, ?)").run(Date.now());

  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Board", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Ship the fixture", { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/w/ws-board/board");

  await page.getByRole("button", { name: "Move Ship the fixture to In progress", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-ui-1'").get() as { state: string }).state).toBe("in-progress");

  await page.getByRole("button", { name: "Move Ship the fixture to Done", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/evidence/i);
  expect((ws.prepare("SELECT state FROM cards WHERE id='card-ui-1'").get() as { state: string }).state).toBe("in-progress");
  expect(errors).toEqual([]);
});

test("board: Done succeeds with explicitly bound verified evidence (T37)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, ws } = await boardWorld(page, governor);
  ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-ui-2', 'Verify the fixture', 'verifying', '[\"echo\"]', 1, ?)").run(Date.now());
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
  await page.getByLabel("Evidence digest for Verify the fixture").fill(DIGEST_A);
  await page.getByRole("button", { name: "Move Verify the fixture to Done", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-ui-2'").get() as { state: string }).state).toBe("done");
  await expect(page.getByText(/evidence attached/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("board: pointer drag moves a card across columns (T37)", async ({ page, governor }, info) => {
  // At phone widths the board is single-column; the explicit move buttons
  // (proven above on every viewport) are the compact path. Pointer drag is
  // exercised where columns sit side by side.
  test.skip(info.project.name.startsWith("390"), "compact board uses explicit move controls, not cross-column drag");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { ws } = await boardWorld(page, governor);
  ws.prepare("INSERT INTO cards(id, title, state, criteria_json, version, created_at_ms) VALUES ('card-drag-1', 'Drag the fixture', 'todo', '[\"echo\"]', 1, ?)").run(Date.now());
  await openBoard(page);
  const card = page.locator("[data-kanban-id='card-drag-1']");
  await expect(card).toBeVisible();
  const from = await card.boundingBox();
  expect(from, "card has a box").toBeTruthy();
  // Drop over the In progress column header area.
  const target = page.getByText("In progress", { exact: true }).first();
  const to = await target.boundingBox();
  expect(to, "target column has a box").toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + 12);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 60, { steps: 24 });
  await page.mouse.up();
  await expect.poll(() => (ws.prepare("SELECT state FROM cards WHERE id='card-drag-1'").get() as { state: string }).state, { timeout: 15_000 }).toBe("in-progress");
  expect(errors).toEqual([]);
  void info;
});
