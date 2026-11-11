import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

// A first-time owner finds where Brain may reach them, sees what this server offers (no webhook, no email), turns the daily digest
// on and finds it still on after a reload; the webhook is shown as unavailable rather than silently broken.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  // The section sits below the fold of the scrolling main region, so photograph the section itself.
  await page.getByTestId("notification-preferences").screenshot({ path: join(SHOTS, `notifications-${name}.png`) });
};

test("notification preferences: in-app always on, digest is a choice, webhook says when the server has none", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Notification organization");
  await page.getByLabel(/^Email/).fill("notify@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Notify workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  await page.goto(`${governor.url}/settings?tab=security`);
  const prefs = page.getByTestId("notification-preferences");
  await expect(prefs).toContainText("Where Brain reaches you");
  await expect(prefs.getByRole("checkbox", { name: /In Brain \(always on\)/ })).toBeDisabled();
  await expect(prefs.getByRole("checkbox", { name: /In Brain \(always on\)/ })).toBeChecked();
  await expect(prefs.getByRole("checkbox", { name: /Browser notifications/ })).toBeChecked();
  const webhook = prefs.getByRole("checkbox", { name: /Webhook: not set up on this server/ });
  await expect(webhook).toBeDisabled();
  await expect(prefs.getByRole("checkbox", { name: /Batch finished results/ })).not.toBeChecked();
  await expect(prefs).toContainText("Every message is a link");
  await expect(prefs.getByRole("checkbox", { name: /Email is not configured on this server/ })).toBeDisabled();
  await shot(page, "1-defaults");

  await prefs.getByRole("checkbox", { name: /Batch finished results/ }).check();
  await expect(prefs.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("notification-preferences").getByRole("checkbox", { name: /Batch finished results/ })).toBeChecked();
  await shot(page, "2-digest-on");
  const accessibility = await new AxeBuilder({ page }).include('[data-testid="notification-preferences"]').analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "notification preferences accessibility").toEqual([]);
  expect(errors).toEqual([]);
});
