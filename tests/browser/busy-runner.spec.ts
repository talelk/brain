import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { fixtureStarter } from "../support/starter";
import { enrollRunners, signUpOwner } from "../support/flow";

/**
 * Track T: a runner whose every slot is busy is still an online, capable runner. Today never blocks the box
 * or shows the setup card for it; it says, calmly, that the new mission queues and starts next. A runner that
 * is really gone still blocks (readiness separates capability from capacity).
 */
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("a busy runner does not block Today: the box stays open, a calm note says the mission queues", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor } = await signUpOwner(page, governor, "busy");
  brain.createWorkspace(actor, { workspaceId: "ws-busy", slug: "busy" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  await enrollRunners(governor, actor, "busy");

  await page.goto(`${governor.url}/w/ws-busy/today`);
  const sentence = page.getByLabel(/^What do you want done/);
  await expect(sentence).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("today-busy-note")).toHaveCount(0);

  // Every slot of the agent runner is taken by running work.
  brain.store.control.prepare("UPDATE runners SET slots_reserved=slot_capacity, cpu_reserved=cpu_capacity-500, memory_reserved=memory_capacity-1024 WHERE id='busy-agents'").run();
  const note = page.getByTestId("today-busy-note");
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText("yours queues and starts next");
  await expect(page.getByText("Nothing runs until you confirm the plan.")).toBeVisible();
  await expect(page.getByText("Blocked until the setup below is done.")).toHaveCount(0);
  await expect(page.getByLabel(/^What do you want done/)).toBeEnabled();
  await expect(page.getByTestId("today-setup").locator('[data-step="runners"][data-status="missing"]')).toHaveCount(0);
  await page.getByLabel(/^What do you want done/).fill("Compare two venues for the offsite");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await shot(page, "busy-runner");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "busy-runner");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Start proceeds: the mission is created and queues.
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/, { timeout: 30_000 });

  // A runner that is really gone still blocks: capability, not capacity.
  brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='busy-agents'").run(brain.store.now() - 10 * 60_000);
  await page.goto(`${governor.url}/w/ws-busy/today`);
  await expect(page.getByTestId("today-setup").locator('[data-step="runners"]')).toHaveAttribute("data-status", "missing", { timeout: 30_000 });
  await expect(sentence).toBeDisabled();
  await expect(page.getByText("Blocked until the setup below is done.")).toBeVisible();
  expect(errors).toEqual([]);
});
