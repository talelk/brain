/**
 * Visual baselines for the key screens at 1440-light and 390-dark (the two projects that are run).
 *
 * UPDATING THESE SNAPSHOTS IS A DELIBERATE ACT. A diff here means the UI changed: look at the actual
 * and diff images in test-results/, decide the change is intended, then regenerate with
 *   TMPDIR=$HOME/.cache/bt npx playwright test tests/browser/visual-baseline.spec.ts \
 *     --project=1440-light --project=390-dark --update-snapshots
 * and commit the new PNGs in tests/browser/visual-baseline.spec.ts-snapshots/ in the same change as
 * the UI work. Never refresh them just to make a red run green. Comparisons allow 2% of pixels to
 * differ (seeded timestamps and ids vary per run); they run on the seeded workspace from
 * tests/support/browserDemo.ts.
 */
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

const SCREENS: Array<{ id: string; route: (demo: Awaited<ReturnType<typeof seedBrowserDemo>>) => string; heading: string | RegExp; testid?: string }> = [
  { id: "missions", route: () => "/w/operations/missions", heading: "Missions" },
  { id: "mission-plan", route: (d) => `/missions/${d.seed.missionIds.active}/plan`, heading: "Stabilize authentication" },
  { id: "mission-live", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication" },
  { id: "plays", route: () => "/w/operations/plays?mode=catalog", heading: "Plays" },
  { id: "live", route: () => "/w/operations/live", heading: "Sessions & runs", testid: "console-rail" },
  { id: "logs", route: () => "/w/operations/logs", heading: "Logs" },
  { id: "outputs", route: () => "/w/operations/outputs", heading: "Outputs" },
  { id: "approvals", route: () => "/approvals", heading: "Approvals" },
  { id: "approval-review", route: (d) => `/approvals/${d.seed.approvalId}`, heading: "Approval review" },
  { id: "runners", route: () => "/runners", heading: "Execution fleet" },
  { id: "settings-setup", route: () => "/settings?tab=setup", heading: "Workspace setup" },
  { id: "knowledge", route: () => "/w/operations/knowledge", heading: "Knowledge" },
];

test("key screens match their visual baselines", async ({ page, governor }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const demo = await seedBrowserDemo(page, governor);
  for (const screen of SCREENS) {
    await page.goto(`${governor.url}${screen.route(demo)}`);
    const landmark = screen.testid
      ? page.getByTestId(screen.testid).getByRole("heading", { name: screen.heading })
      : page.getByRole("heading", { name: screen.heading }).first();
    await expect(landmark.first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`${screen.id}.png`, { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  }
});
