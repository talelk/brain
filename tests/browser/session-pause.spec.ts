import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ActorContext } from "@brain/contracts";
import { test, expect } from "./fixtures";
import { PAUSABLE_FEATURES, heartbeatCommands, runnerReports, runningSession } from "../support/running-session";
import { fixtureStarter } from "../support/starter";

/**
 * Pausing ONE session as a first-time user meets it (ADR 0058). Two team members are working. A person holds one of them at its next turn
 * and sees it paused, in the console and in the rail, while the mission and the other member carry on; steer and stop still work on the held
 * session; Continue lets the very same session go on. The member whose engine cannot stop at a turn boundary shows the control disabled, with the reason.
 * The runner's part (the engine reaching its boundary, running again) comes through the runner protocol, as a real runner would report it.
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
  await page.getByLabel(/^Organization name/).fill("Pause organization");
  await page.getByLabel(/^Email/).fill("pause@example.test");
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

test("a person pauses one session, steers and continues it, while the mission and the other member carry on", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await setUp(page, governor);
  const writer = await runningSession(w.brain, w.actor, w.workspaceId, "runner-writer", "Draft the board summary", "pause-writer", PAUSABLE_FEATURES);
  const checker = await runningSession(w.brain, w.actor, w.workspaceId, "runner-checker", "Check the vendor sheet", "pause-checker", ["sessions", "steer"]);
  const missionState = (id: string) => (w.brain.store.workspaceDb(w.workspaceId, w.actor.organizationId).prepare("SELECT state FROM missions WHERE id=?").get(id) as { state: string }).state;
  const rowOf = (id: string) => page.locator(`[data-testid="rail-session"][data-session-id="${id}"]`);

  // From the menu to the Live console, the way a person who wants to hold one agent would go.
  const navToggle = page.getByRole("button", { name: "Open application navigation", exact: true });
  const nav = page.getByRole("navigation", { name: "Brain navigation" });
  const openNav = async () => { if ((await navToggle.isVisible()) && (await page.locator('dialog[data-slot="app-shell-drawer"][open]').count()) === 0) await navToggle.click(); };
  await openNav();
  await nav.getByRole("button", { name: "Missions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Missions", exact: true, level: 1 })).toBeVisible();
  await openNav();
  await nav.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Live", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Working now (2)")).toBeVisible({ timeout: 30_000 });
  await rowOf(writer.sessionId).click();

  // The writer can be paused: the control is there beside the mission's own pause, which is labelled for what it does.
  const pause = page.getByRole("button", { name: "Pause session", exact: true });
  await expect(pause).toBeEnabled();
  await expect(page.getByRole("button", { name: "Pause mission", exact: true })).toBeVisible();
  await shot(page, "pause-1-running");

  await pause.click();
  await expect(page.getByRole("status").filter({ hasText: /^Pause requested/ })).toBeVisible();
  await expect(page.getByTestId("pause-note")).toContainText("hold at the end of its current turn");
  await expect(page.getByTestId("console-now")).toContainText("Pausing: this session will hold at the end of its current turn.");
  // The runner is told, on its next heartbeat; the other member's runner is not.
  expect(heartbeatCommands(w.brain, writer)).toEqual(["pause-attempt"]);
  expect(heartbeatCommands(w.brain, checker)).toEqual([]);
  await shot(page, "pause-2-pausing");

  // The engine reaches the end of its turn and holds there: the person sees it paused, in the console and in the list.
  runnerReports(w.brain, writer, "session-paused");
  await expect(page.getByTestId("continue-session")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pause-note")).toContainText("keeps its place and runner slot");
  await expect(page.getByTestId("pause-note")).toContainText("Brain stops it at");
  await expect(page.getByTestId("console-now")).toContainText("Paused. This session is holding its place");
  await expect(rowOf(writer.sessionId)).toContainText("Paused");
  await expect(rowOf(checker.sessionId)).not.toContainText("Paused");
  await shot(page, "pause-3-paused");
  // The mission and the other member are untouched.
  expect(missionState(writer.missionId)).toBe("active");
  expect(missionState(checker.missionId)).toBe("active");
  await expect(page.getByRole("button", { name: "Pause mission", exact: true })).toBeVisible();

  // Steering still works on the held session: it waits for the first turn after the continue.
  await page.getByRole("button", { name: /^Steer/ }).click();
  await page.getByLabel("Steering message").fill("Lead with the cost figures");
  await page.getByRole("button", { name: "Send steering" }).click();
  await expect.poll(() => (w.brain.store.workspaceDb(w.workspaceId, w.actor.organizationId).prepare("SELECT COUNT(*) AS c FROM session_controls WHERE kind='session.steer'").get() as { c: number }).c).toBe(1);

  // The other member's engine cannot stop at a turn boundary: the control is there, disabled, and says why.
  await rowOf(checker.sessionId).click();
  await expect(page.getByRole("button", { name: "Pause session", exact: true })).toBeDisabled();
  await expect(page.getByTestId("pause-unsupported")).toContainText("cannot stop at a turn boundary");
  await expect(page.getByTestId("pause-session")).toHaveAttribute("title", /cannot stop at a turn boundary/);
  await shot(page, "pause-4-unsupported");

  // Continue: the same session goes on; nothing new starts.
  await rowOf(writer.sessionId).click();
  await page.getByTestId("continue-session").click();
  await expect(page.getByRole("status").filter({ hasText: /^Continue requested/ })).toBeVisible();
  await expect(page.getByTestId("continuing-session")).toBeVisible();
  expect(heartbeatCommands(w.brain, writer)).toContain("continue-attempt");
  runnerReports(w.brain, writer, "session-continued");
  await expect(page.getByRole("button", { name: "Pause session", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("pause-note")).toHaveCount(0);
  await expect(rowOf(writer.sessionId)).not.toContainText("Paused");
  expect(page.url()).toContain(writer.sessionId);
  expect(missionState(writer.missionId)).toBe("active");

  // A held session can still be stopped, and the stop is delivered until the runner has acted on it.
  await page.getByRole("button", { name: "Pause session", exact: true }).click();
  runnerReports(w.brain, writer, "session-paused");
  await expect(page.getByTestId("continue-session")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByLabel("Stop reason").fill("Wrong direction");
  await page.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => heartbeatCommands(w.brain, writer)).toEqual(["stop-attempt"]);
  expect(heartbeatCommands(w.brain, writer)).toEqual(["stop-attempt"]);
  expect(errors).toEqual([]);
});
