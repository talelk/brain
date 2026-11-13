import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { seedBrowserDemo } from "../support/browserDemo";

/** On a phone the sidebar is a drawer behind a toggle. */
async function openNav(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * Phase 2, one simple surface: Today's Working-now strip and the Missions Running filter read one live store, so
 * "running", the counts and the header cannot disagree; one Refresh and one freshness label serve every screen;
 * instance-wide pages say so instead of offering a workspace switcher; one decision card shape everywhere.
 */
test("Working now, the Running filter and every count read one live store and agree", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const brain = governor.app.brain;
  const row = brain.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE id=?").get(demo.workspaceId) as { id: string; organization_id: string };
  const db = brain.store.workspaceDb(row.id, row.organization_id);

  // Nothing runs yet: the strip says so, and the Running filter is empty.
  await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
  const strip = page.getByTestId("working-now");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("working-now-idle")).toHaveText("Nothing is running right now.");
  await page.goto(`${governor.url}/w/${demo.workspaceId}/missions?show=running`);
  await expect(page.getByText("Nothing is running", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("radio", { name: /^Running \(0\)/ })).toBeChecked();

  // One mission has a task working. A raw ledger row emits no event, so the page reads again once (a real attempt emits one and the store re-reads by itself).
  db.prepare("INSERT INTO mission_spend(attempt_id, mission_id, run_id, reserved_micro_usd, created_at_ms) VALUES ('att-running-1', ?, 'run-running-1', 1000, ?)").run(demo.seed.missionIds.active, brain.store.now());
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Running \(1\)/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Open mission Stabilize authentication/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open mission Prepare the quarterly review/ })).toHaveCount(0);
  await page.getByRole("radio", { name: /^All \(/ }).click();
  await expect(page.getByRole("button", { name: /Open mission Prepare the quarterly review/ })).toBeVisible();

  // The strip on Today names the same mission and the same count, and opens its Live view.
  await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
  await expect(page.getByTestId("working-now-count")).toContainText("1 mission running");
  await expect(page.getByTestId("working-now-count")).toContainText("1 task running");
  await page.getByRole("button", { name: "Open Stabilize authentication", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/missions/${demo.seed.missionIds.active}/live`));
  expect(errors).toEqual([]);
});

test("one Refresh and one freshness label; pages carry no refresh buttons of their own", async ({ page, governor }) => {
  const demo = await seedBrowserDemo(page, governor);
  for (const path of ["today", "missions", "library", "schedules", "outputs"]) {
    await page.goto(`${governor.url}/w/${demo.workspaceId}/${path}`);
    await expect(page.getByTestId("live-freshness")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(1);
  }
  await page.goto(`${governor.url}/w/${demo.workspaceId}/missions`);
  await expect(page.getByTestId("live-freshness")).toContainText("Updated just now", { timeout: 30_000 });
  // A command the person runs re-reads every screen at once: the header count and the list below it change together.
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/v1/query") && request.method() === "POST") requests.push(String((request.postDataJSON() as { queryType?: string }).queryType)); });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => requests.filter((type) => type === "attention.list").length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => requests.filter((type) => type === "missions.list").length, { timeout: 10_000 }).toBe(1);
});

test("instance-wide pages say so instead of offering a workspace switcher that changes nothing", async ({ page, governor }) => {
  const demo = await seedBrowserDemo(page, governor);
  await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
  await expect(page.getByTestId("live-freshness")).toBeVisible({ timeout: 30_000 });
  await openNav(page);
  await expect(page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Operations", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("instance-wide")).toHaveCount(0);
  for (const target of ["/settings?tab=setup", "/settings?tab=health", "/quality"]) {
    await page.goto(`${governor.url}${target}`);
    await expect(page.getByTestId("live-freshness")).toBeVisible({ timeout: 30_000 });
    await openNav(page);
    await expect(page.getByTestId("instance-wide").filter({ visible: true })).toHaveText("Whole instance", { timeout: 30_000 });
    await expect(page.getByRole("navigation", { name: "Brain navigation" }).getByRole("button", { name: "Operations", exact: true })).toHaveCount(0);
  }
  await page.goto(`${governor.url}/settings?tab=health`);
  await expect(page.getByText("Recent activity in this workspace")).toBeVisible({ timeout: 30_000 });
});

test("everything that needs a person is one decision card: what happened, why, the recommended action, the other options", async ({ page, governor }) => {
  const demo = await seedBrowserDemo(page, governor);
  await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
  const cards = page.getByTestId("needs-you-item");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  for (const card of await cards.all()) {
    await expect(card.locator("h3")).toHaveCount(1);
    await expect(card.locator('[data-decision-slot="recommended"]')).toHaveCount(1);
    // Two verbs for everything: Decide and Retry (plus the plain result link); never Unblock or Try again.
    await expect(card.getByRole("button", { name: /^(Unblock|Try again)$/ })).toHaveCount(0);
  }
  // The same card on Missions.
  await page.goto(`${governor.url}/w/${demo.workspaceId}/missions`);
  await expect(page.getByTestId("needs-you").getByTestId("needs-you-item").first()).toBeVisible({ timeout: 30_000 });
});
