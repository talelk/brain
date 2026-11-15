import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { seedChangeApproval } from "../support/changeApprovalDemo";

/**
 * Approvals with context (#120, ADR 0048), walked like a first-time approver: from the navigation to the Approvals page, pick a change,
 * read which mission, task and run it belongs to, the files it would commit as a diff (not JSON) and the rollback, then approve it.
 * An approval with no origin and no declared rollback says so in words. Runs at 390, 768 and 1440 px: approvals are a phone flow.
 */
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test("an approver reads where a change was asked, its diff and its rollback, then approves it once", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const brain = governor.app.brain;
  const demo = await seedBrowserDemo(page, governor);
  const change = await seedChangeApproval(brain, demo.actor, demo.workspaceId, { runId: "demo-run-progress", key: "walk-change" });

  await page.goto(`${governor.url}/w/operations/today`);
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if (await navToggle.isVisible()) await navToggle.click();
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await page.getByRole("region", { name: "Approvals", exact: true }).getByRole("button", { name: `Review: ${change.approvalId}`, exact: true }).click();

  // Which mission and task the change belongs to, and the run, as links a person can follow.
  const context = page.locator("[data-approval-context]").first();
  await expect(context.locator("[data-approval-mission]")).toHaveText("Stabilize authentication");
  await expect(context.locator("[data-approval-task]")).toHaveText("Reproduce the latency regression");
  await expect(context.locator("[data-approval-run]")).toHaveText("demo-run-progress");
  await expect(context.locator("[data-approval-mission] a")).toHaveAttribute("href", /\/missions\/mission-[^/]+\/plan\?w=operations$/u);
  // The change is a file diff: the files, then added lines, and the arguments are not shown as JSON.
  await expect(context.locator("[data-approval-files]")).toContainText("docs/demo-app/limits.md");
  await expect(context.locator("[data-approval-files]")).toContainText("deploy/demo-app.env");
  const diff = context.locator("[data-approval-diff]");
  await expect(diff).toContainText("+++ b/docs/demo-app/limits.md");
  await expect(diff).toContainText("+memory: 768m");
  await expect(diff).toContainText("+MEMORY_LIMIT=768m");
  await expect(page.getByText('"files"').first()).toBeHidden();
  // What undoes it, and that Brain does not run it.
  await expect(context.locator("[data-approval-rollback=declared]")).toContainText("Rollback: Close the pull request and delete its branch.");
  await expect(context.locator("[data-approval-rollback=declared]")).toContainText("does not run it");
  expect(await noSideways(page)).toBe(true);

  // The review dialog leads with the same context before the exact details.
  await page.getByRole("button", { name: "Review action", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-approval-mission]")).toHaveText("Stabilize authentication");
  await expect(dialog.locator("[data-approval-diff]")).toContainText("+memory: 768m");
  await expect(dialog.locator("[data-approval-rollback=declared]")).toBeVisible();
  await dialog.getByLabel(/^Decision note/).fill("Limits match the container's history");
  await dialog.getByRole("button", { name: "Approve exact action", exact: true }).click();
  await expect(page.getByText(/Decision recorded/).first()).toBeVisible();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(change.approvalId) as { state: string }).state).toBe("approved");
  // Single-use: one decision, and the same approval offers no second one.
  expect(brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_decisions WHERE approval_id=?").get(change.approvalId)).toEqual({ n: 1 });
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review action", exact: true })).toBeDisabled();

  // An approval that names no mission and whose tool declares no rollback says so, in words.
  await page.goto(`${governor.url}/approvals`);
  await page.getByRole("region", { name: "Approvals", exact: true }).getByRole("button", { name: `Review: ${demo.seed.approvalId}`, exact: true }).click();
  const plain = page.locator("[data-approval-context]").first();
  await expect(plain.locator("[data-approval-mission]")).toHaveText("Not part of a mission");
  await expect(plain.locator("[data-approval-rollback=none]")).toHaveText("No rollback declared");
  await expect(plain.locator("[data-approval-diff]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the approval link a phone opens shows the context, the diff and the rollback on one card and nothing scrolls sideways", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const change = await seedChangeApproval(governor.app.brain, demo.actor, demo.workspaceId, { runId: "demo-run-progress", key: "walk-card" });

  await page.goto(`${governor.url}/approvals/${change.approvalId}`);
  const card = page.locator("[data-approval-card]");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("[data-approval-mission]")).toHaveText("Stabilize authentication");
  await expect(card.locator("[data-approval-task]")).toHaveText("Reproduce the latency regression");
  await expect(card.locator("[data-approval-diff]")).toContainText("+memory: 768m");
  await expect(card.locator("[data-approval-rollback=declared]")).toContainText("Close the pull request");
  // The arguments are the diff now, not a list of key: value pairs with the files as JSON.
  await expect(card.locator("[data-approval-arguments]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  expect(await noSideways(page)).toBe(true);
  // A long diff line scrolls inside its own block, not the page.
  const diff = card.locator("[data-approval-diff]");
  expect(await diff.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(/auto|scroll/u);
  expect(errors).toEqual([]);
});
