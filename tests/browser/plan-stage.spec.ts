import { mkdirSync } from "node:fs";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

// While a plan is being drafted the page says which step Brain is on (reading, drafting, checking), from MissionPlanView.stage.
const SHOTS = process.env["BRAIN_SHOTS"];

test("a plan in progress names its stage in plain words", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const demo = await seedBrowserDemo(page, governor);
  let stage: "reading" | "drafting" | "checking" = "reading";
  await page.route("**/v1/plans/*?workspaceId=*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ missionId: demo.seed.missionIds.active, runId: "run-x", state: "running", stage }),
  }));
  await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/plan`);
  const alert = page.locator("main").filter({ hasText: "Preparing a validated proposal" }).last();
  await expect(alert).toContainText("Reading what the workspace knows...", { timeout: 20_000 });
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/plan-reading.png` }); }
  stage = "drafting";
  await expect(alert).toContainText("Drafting the steps...", { timeout: 10_000 });
  stage = "checking";
  await expect(alert).toContainText("Checking the plan...", { timeout: 10_000 });
  if (SHOTS) { await page.getByText("Checking the plan...").scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/plan-checking.png` }); }
});
