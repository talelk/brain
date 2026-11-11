import { test, expect } from "./fixtures";

test("administration pages open with a plain verdict, honest status and who-can-do-what", async ({ page, governor }) => {
  test.setTimeout(120_000);
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Clarity");
  await page.getByLabel(/^Email/).fill("owner@example.test");
  await page.getByLabel(/^Password/).fill("owner-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await page.getByLabel("Display name").fill("Clarity workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  await page.goto(`${governor.url}/administration/workspaces`);
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true, level: 1 })).toBeVisible();

  await page.goto(`${governor.url}/settings?tab=health`);
  await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Everything is working", { exact: true })).toBeVisible();
  await expect(page.getByText("Brain server", { exact: true })).toBeVisible();

  await page.goto(`${governor.url}/settings?tab=release`);
  await expect(page.getByText("No releases compiled yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Gate evidence")).toHaveCount(0);
  await expect(page.getByLabel("Config pointer")).toHaveCount(0);

  await page.goto(`${governor.url}/settings?tab=members`);
  await expect(page.getByLabel("What each role can do")).toContainText("Workspace lead");
  await expect(page.getByText("Has access", { exact: true }).first()).toBeVisible();
});
