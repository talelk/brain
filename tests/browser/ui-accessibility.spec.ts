import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

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
  return (governor.app.brain.store.control.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
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
  await page.getByPlaceholder("Search attention, missions, or workspace…").fill(french);
  await expect(page.getByPlaceholder("Search attention, missions, or workspace…")).toHaveValue(french);
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  for (const route of [`/w/${workspaceId}/missions`, `/w/${workspaceId}/workflows?mode=catalog`, "/approvals", "/tv/sre"]) {
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
  await page.goto(`${governor.url}/w/${workspaceId}/support`);
  await expect(page.getByRole("alert")).toContainText("Some data is unavailable");
  await expect(page.getByText("No tickets in this view", { exact: true })).toBeVisible();
});
