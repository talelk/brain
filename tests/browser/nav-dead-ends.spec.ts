import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "./fixtures";

// Two dead ends a first-time owner used to hit: Live was missing from the Missions menu (only a deep link reached it), and the link in a
// platform-alert notification pointed at a page that does not exist, so it dropped the person on Today.

async function setUp(page: import("@playwright/test").Page, governor: { url: string; credential: string }): Promise<void> {
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Dead ends organization");
  await page.getByLabel(/^Email/).fill("deadends@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Operations");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
}

test("Live is in the Missions menu next to Schedules and All results, and opens the running-work console", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setUp(page, governor);

  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  const nav = page.getByRole("navigation", { name: "Brain navigation" });
  /** The phone drawer opens once; on wider screens the menu is always there. */
  const openNav = async () => { if ((await navToggle.isVisible()) && (await page.locator('dialog[data-slot="app-shell-drawer"][open]').count()) === 0) await navToggle.click(); };

  await openNav();
  await nav.getByRole("button", { name: "Missions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  await openNav();
  for (const view of ["Approvals", "Live", "Schedules", "All results"]) await expect(nav.getByRole("button", { name: view, exact: true })).toBeVisible();

  await nav.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/live$/);
  await expect(page.getByRole("heading", { name: "Live", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Nothing is running", { exact: true })).toBeVisible();
  // Live is a view of Missions, so the menu stays the Missions menu.
  await openNav();
  await expect(nav.getByRole("button", { name: "Schedules", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a platform alert's link opens the Health tab", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const received: string[] = [];
  const hook: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(Buffer.concat(chunks).toString("utf8")); response.writeHead(204).end(); });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  const saved = { hook: process.env["BRAIN_NOTIFY_WEBHOOK_URL"], model: process.env["BRAIN_LOCAL_MODEL_URL"] };
  process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  try {
    await setUp(page, governor);
    const brain = governor.app.brain;
    const cookies = await page.context().cookies();
    const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }))).actor;
    brain.setNotificationPreferences(actor, { webhook: true, push: false });

    // The model endpoint stops answering: the owner is alerted on the channels they switched on.
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://model.invalid/v1";
    await brain.runEngineProbes((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const link = (JSON.parse(received.find((body) => body.includes('"platform"')) ?? received[0]!) as { link: string }).link;
    expect(new URL(link).pathname + new URL(link).search).toBe("/settings?tab=health");

    // Opening the link lands on Health, with the services on it, not on Today.
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?tab=health$/);
    expect(errors).toEqual([]);
  } finally {
    if (saved.hook === undefined) delete process.env["BRAIN_NOTIFY_WEBHOOK_URL"]; else process.env["BRAIN_NOTIFY_WEBHOOK_URL"] = saved.hook;
    if (saved.model === undefined) delete process.env["BRAIN_LOCAL_MODEL_URL"]; else process.env["BRAIN_LOCAL_MODEL_URL"] = saved.model;
    await new Promise((resolve) => hook.close(resolve));
  }
});
