import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

async function createWorkspace(page: import("@playwright/test").Page, governor: { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Accessibility organization");
  await page.getByLabel(/^Email/).fill("accessibility@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Accessible workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  const row = governor.app.brain.store.control.prepare("SELECT id, organization_id FROM workspaces LIMIT 1").get() as { id: string; organization_id: string };
  // A workspace with no mission at all shows the first-mission invitation; these specs exercise the loaded screen, so seed one mission.
  const now = Date.now();
  governor.app.brain.store.workspaceDb(row.id, row.organization_id)
    .prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-a11y','Accessibility mission','Fixture intent','[\"echo\"]','owner',?,?)").run(now, now);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  return row.id;
}

test("keyboard, 200% zoom, French input, RTL and reduced motion remain contained", async ({ page, governor }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const workspaceId = await createWorkspace(page, governor);
  await expect(page.getByText("Nothing needs you", { exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await expect(page.getByRole("button", { name: "New mission", exact: true })).toBeVisible();
  const zoomContainment = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(zoomContainment).toBe(true);

  await page.goto(`${governor.url}/w/${workspaceId}/missions`);
  const french = "Examiner attentivement les autorisations et les preuves indépendantes avant toute activation en production";
  await page.getByRole("button", { name: "Search Brain (Control K)" }).click();
  const search = page.getByPlaceholder("Try a session, run, approval, output, Agent or Workflow");
  await search.fill(french);
  await expect(search).toHaveValue(french);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  for (const route of [`/w/${workspaceId}/missions`, `/w/${workspaceId}/plays?mode=catalog`, "/approvals", "/tv/sre"]) {
    await page.goto(`${governor.url}${route}`);
    const contained = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(contained, `${route} at 200% zoom and RTL`).toBe(true);
  }
  await page.goto(`${governor.url}/w/${workspaceId}/missions`);
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  const duration = await page.getByRole("main").evaluate((element) => {
    element.classList.add("brain-region-enter");
    return element.firstElementChild ? getComputedStyle(element.firstElementChild).animationDuration : "";
  });
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
  const output = join(process.cwd(), "artifacts", "ui-revamp", "accessibility");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, `${info.project.name}-zoom-rtl.png`), fullPage: true });
});

test("loading, no-access, stale, partial failure and retry states use real response outcomes", async ({ page, governor }) => {
  const workspaceId = await createWorkspace(page, governor);
  const today = page.getByText("Nothing needs you", { exact: true });
  await expect(today).toBeVisible();

  await page.route("**/v1/query", async (route) => {
    const body = route.request().postDataJSON() as { queryType?: string };
    if (body.queryType === "attention.list") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("region", { name: "Needs you" }).getByRole("status", { name: "Loading", exact: true })).toBeVisible();
  await expect(today).toBeVisible();
  await page.unroute("**/v1/query");

  await page.route("**/v1/query", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Injected read failure" }) }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("Showing the last authorized result");
  await expect(page.getByRole("button", { name: "New mission", exact: true })).toBeVisible();
  await page.unroute("**/v1/query");

  await page.route("**/v1/query", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "Access revoked" }) }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("Your account no longer has access to this content");
  await expect(page.getByText("Nothing needs you", { exact: true })).toHaveCount(0);
  await page.unroute("**/v1/query");

  await page.route("**/v1/query", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Injected read failure" }) }));
  await page.reload();
  await expect(page.getByRole("alert").first()).toContainText("Governor could not complete this read");
  await expect(page.getByRole("button", { name: "Try again", exact: true }).first()).toBeVisible();
  await page.unroute("**/v1/query");

  await page.route("**/v1/query", async (route) => {
    const body = route.request().postDataJSON() as { queryType?: string };
    if (body.queryType === "sla.summary") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "SLA provider unavailable" }) });
    else await route.continue();
  });
  await page.goto(`${governor.url}/w/${workspaceId}/plays/support`);
  await expect(page.getByRole("alert")).toContainText("Some data is unavailable");
  await expect(page.getByText("No tickets in this view", { exact: true })).toBeVisible();
});

test("axe: key seeded screens have no serious or critical violations", async ({ page, governor }, info) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const demo = await seedBrowserDemo(page, governor);
  const screens: Array<[string, string, string | RegExp]> = [
    ["missions", "/w/operations/missions", "Missions"],
    ["mission-plan", `/missions/${demo.seed.missionIds.active}/plan`, "Stabilize authentication"],
    ["live", "/w/operations/live", "Sessions & runs"],
    ["outputs", "/w/operations/outputs", "Outputs"],
    ["approvals", "/approvals", "Approvals"],
    ["plays", "/w/operations/plays?mode=catalog", "Plays"],
    ["settings-setup", "/settings?tab=setup", "Setup"],
    ["runners", "/runners", "Runners"],
  ];
  const failures: string[] = [];
  for (const [id, route, heading] of screens) {
    await page.goto(`${governor.url}${route}`);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(200);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const violation of violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical")) {
      failures.push(`${info.project.name} ${id}: ${violation.id} (${violation.impact}) x${violation.nodes.length} e.g. ${violation.nodes[0]?.target.join(" ")} :: ${violation.nodes[0]?.failureSummary?.split("\n")[1] ?? ""}`);
    }
  }
  expect(failures, "serious or critical accessibility violations").toEqual([]);
});
