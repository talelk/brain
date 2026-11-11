import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * Right-to-left layout. The Playwright project `1440-light-rtl` uses the Arabic browser language, which makes the app set
 * dir="rtl" (apps/web/src/main.tsx; `?dir=rtl` forces it by hand). These checks run only there.
 */
test("right-to-left: direction, sliding tab indicator, mirrored arrows and resizable panes follow the reading order", async ({ page, governor }, info) => {
  test.skip(!info.project.name.endsWith("-rtl"), "runs in the RTL project only");
  test.setTimeout(120_000);
  const demo = await seedBrowserDemo(page, governor);

  await page.goto(`${governor.url}/w/operations/logs?view=runs`);
  await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

  // The sliding tab indicator sits behind the active tab, not at the opposite edge.
  const overlap = async (label: string) => {
    const tab = await page.getByRole("radio", { name: label }).or(page.getByText(label, { exact: true })).first().boundingBox();
    const pill = await page.locator('[data-slot="tab-indicator"]').first().boundingBox();
    expect(tab && pill, `${label} tab and indicator are laid out`).toBeTruthy();
    expect(Math.abs((pill!.x + pill!.width / 2) - (tab!.x + tab!.width / 2)), `indicator centred on ${label}`).toBeLessThan(12);
  };
  await page.waitForTimeout(400);
  await overlap("Runs");
  await page.getByText("Log explorer", { exact: true }).click();
  await page.waitForTimeout(400);
  await overlap("Log explorer");

  // Directional icons mirror: the flow stepper's chevrons point along the reading direction.
  await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/plan`);
  const chevron = page.locator(".lucide-chevron-right").first();
  await expect(chevron).toBeVisible();
  expect(await chevron.evaluate((element) => getComputedStyle(element).scale)).toBe("-1 1");

  // Arrow keys on a pane divider grow the pane that sits on the right in RTL, so ArrowLeft grows the sessions rail.
  await page.goto(`${governor.url}/w/operations/live`);
  const rail = page.getByTestId("console-rail");
  await expect(rail).toBeVisible();
  const before = (await rail.boundingBox())!.width;
  const divider = page.getByRole("button", { name: /Resize the sessions rail/ });
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(before);
});
