import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ActorContext } from "@brain/contracts";
import { test, expect } from "./fixtures";
import { command, interruptedSession } from "../support/interrupted-session";
import { fixtureStarter } from "../support/starter";

/**
 * "Resume from checkpoint" as a first-time user meets it (ADR 0045). An agent's attempt stopped before it finished and left a checkpoint on
 * the runner that took it. Where that runner is still there the console offers the resume and it starts a new session from the checkpoint,
 * which says where it started from; where the runner is gone the console says so in plain words and leaves the fresh start.
 * The attempt, its failure and its checkpoint come through the runner protocol, as a real runner would send them.
 */
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${page.viewportSize()?.width}.png`), fullPage: true });
};

async function setUp(page: Page, governor: { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Resume organization");
  await page.getByLabel(/^Email/).fill("resume@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  await page.getByLabel("Display name").fill("Operations");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const workspaceId = /\/w\/([^/]+)\//.exec(page.url())![1]!;
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor: ActorContext = (await brain.resolveActor(new Headers({ cookie }), workspaceId)).actor;
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  return { brain, actor, workspaceId };
}

/** From the menu to the failed session in the Live console, the way a person who just heard the task stopped would go. */
async function openFailedSession(page: Page): Promise<void> {
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  const nav = page.getByRole("navigation", { name: "Brain navigation" });
  const openNav = async () => { if ((await navToggle.isVisible()) && (await page.locator('dialog[data-slot="app-shell-drawer"][open]').count()) === 0) await navToggle.click(); };
  await openNav();
  await nav.getByRole("button", { name: "Missions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  await openNav();
  await nav.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Live", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open the latest session" }).click();
  await expect(page.getByText("This session failed.")).toBeVisible({ timeout: 30_000 });
}

const bannerOf = (page: Page) => page.getByText("This session failed.").locator("xpath=ancestor::div[contains(@class,'bg-surface-amber-1')]");

test("a failed session whose runner is online offers Resume from checkpoint; resuming starts a new session that shows its checkpoint", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await setUp(page, governor);
  await interruptedSession(w.brain, w.actor, w.workspaceId, "runner-office", "Summarise the board papers", "resume-online");

  await openFailedSession(page);
  const banner = bannerOf(page);
  await expect(banner.getByRole("button", { name: "Resume from checkpoint", exact: true })).toBeVisible();
  // It says where the new session will run, and that it continues the conversation instead of starting over.
  await expect(banner).toContainText("runner-office");
  await expect(banner).toContainText("instead of starting the task over");
  await shot(page, "resume-offered");

  await banner.getByRole("button", { name: "Resume from checkpoint", exact: true }).click();
  // The console follows the new session, which says where it began: the checkpoint, its runner and the earlier session.
  const from = page.getByTestId("resumed-from");
  await expect(from).toBeVisible({ timeout: 30_000 });
  await expect(from).toContainText(/checkpoint sha256:[0-9a-f]{8}/);
  await expect(from).toContainText("runner-office");
  await expect(from.getByRole("link", { name: "Earlier session" })).toBeVisible();
  // The new session has not failed, so the recovery banner is gone.
  await expect(page.getByText("This session failed.")).toHaveCount(0);
  await shot(page, "resume-started");

  // The earlier session is still there, still failed, with its checkpoint: a second resume is refused while the first run is going.
  await from.getByRole("link", { name: "Earlier session" }).click();
  await expect(page.getByText("This session failed.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("resume-unavailable")).toContainText("already going");
  await expect(bannerOf(page).getByRole("button", { name: "Resume from checkpoint" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a failed session whose runner is gone says so plainly and leaves the fresh start", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await setUp(page, governor);
  await interruptedSession(w.brain, w.actor, w.workspaceId, "runner-retired", "Summarise the board papers", "resume-gone");
  // The runner that held the checkpoint is taken out of service.
  await command(w.brain, w.actor, w.workspaceId, "runner.control", "retire", { runnerId: "runner-retired", action: "deregister", reason: "retired" });

  await openFailedSession(page);
  const banner = bannerOf(page);
  await expect(banner.getByRole("button", { name: "Resume from checkpoint" })).toHaveCount(0);
  await expect(page.getByTestId("resume-unavailable")).toContainText("Runner runner-retired held this checkpoint and is no longer registered");
  await expect(page.getByTestId("resume-unavailable")).toContainText("start the task again from the beginning");
  // What is offered instead is the fresh start. The task stopped for a person, so it is "Decide": the mission's plan, where it is retried or changed.
  await expect(banner.getByRole("button", { name: "Decide", exact: true })).toBeVisible();
  await shot(page, "resume-unavailable");
  await banner.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/plan/);
  expect(errors).toEqual([]);
});
