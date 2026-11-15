import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { runOnce } from "../../apps/runner/src/supervisor";
import { test, expect } from "./fixtures";
import { enrollRunners, signUpOwner, type GovernorFixture, type RunnerSession } from "../support/flow";
import { fixtureStarter } from "../support/starter";

// A first-time user starts a mission from the starter Play that has a coordinator and watches the coordinator work (ticket 108, ADR 0045).
// The fixture engine stands in for the model; the Governor's maintenance pass is what this spec's `drive` does between runner turns.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `coordinator-${name}.png`), fullPage: true });
};

const TITLE = "Research and write, planned by a coordinator";

async function drive(governor: GovernorFixture, sessions: readonly RunnerSession[], until: () => boolean, timeoutMs = 120_000): Promise<void> {
  const brain = governor.app.brain;
  const deadline = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("the mission did not get there in time");
    // The runners' heartbeat timer, which `runOnce` does not run: a runner silent for 45 s is not offered work.
    brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=?").run(brain.store.now());
    brain.missions.pumpCoordinators();
    await brain.autoStart.sweepAll();
    let worked = false;
    for (const session of sessions) worked = (await runOnce(session.cfg, session.sessionToken, session.epoch)) || worked;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("start a mission from the coordinator Play, confirm its starting plan, and watch the coordinator plan and re-plan", async ({ page, governor }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "coordinator");
  brain.createWorkspace(actor, { workspaceId: "ws-coordinator", slug: "coordinator" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-coordinator")).actor;
  const sessions = await enrollRunners(governor, actor, "coordinator");
  const db = brain.store.workspaceDb("ws-coordinator", actor.organizationId);
  const plans = () => (db.prepare("SELECT revision, state, origin FROM plan_versions ORDER BY revision").all() as Array<{ revision: number; state: string; origin: string }>);
  void scoped;

  // The person picks the Play on Today and types the goal, as a first-time user would.
  await page.goto(`${governor.url}/w/ws-coordinator/today`);
  const goal = "Compare three venues for the autumn offsite";
  if ((page.viewportSize()?.width ?? 1440) < 640) {
    // A phone shows the first three Plays on Today; the rest are behind "4 more Plays", which opens the Plays list.
    await page.getByRole("button", { name: "4 more Plays" }).click();
    await page.getByRole("button", { name: `Open play ${TITLE}` }).click();
    await page.getByRole("button", { name: "Start a mission", exact: true }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel(/^What do you want done/).fill(goal);
    await shot(page, "1-play-picked");
    await form.getByRole("button", { name: "Start mission", exact: true }).click();
  } else {
    await page.getByRole("button", { name: TITLE, exact: true }).click();
    await expect(page.getByTestId("start-seed")).toContainText(TITLE);
    await page.getByLabel(/^What do you want done/).fill(goal);
    await shot(page, "1-play-picked");
    await page.getByRole("button", { name: "Start", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (db.prepare("SELECT id FROM missions").get() as { id: string }).id;

  // The Play's starting plan waits for the person's confirmation, as any first plan does. Nothing has woken the coordinator.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByRole("button", { name: "Confirm this plan", exact: true })).toBeVisible();
  expect(plans()).toEqual([{ revision: 1, state: "proposed", origin: "template" }]);
  await shot(page, "2-starting-plan");
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => plans().map((entry) => entry.state)).toEqual(["confirmed"]);

  // The confirmation wakes the coordinator: it reads the mission and proposes a better plan, which its autonomy confirms by itself.
  await drive(governor, sessions, () => plans().length >= 2);
  expect(plans()).toEqual([{ revision: 1, state: "superseded", origin: "template" }, { revision: 2, state: "confirmed", origin: "agent" }]);

  // Team: the coordinator is marked, and says what it does and does not do.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/team`);
  await expect(page.locator("[data-coordinator='lead']")).toHaveText("Coordinator");
  await expect(page.locator("[data-coordinator-note]")).toContainText("It starts no task, records no verdict and confirms nothing itself");
  await shot(page, "3-team");

  // Live: the coordinator's own session is on the team rail with its work.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/live`);
  await expect(page.getByRole("button", { name: /^Follow Coordinator \(lead\)/ })).toBeVisible();
  await page.getByRole("button", { name: /^Follow Coordinator \(lead\)/ }).click();
  await expect(page.getByText("Coordinator session").first()).toBeVisible();
  await shot(page, "4-live-coordinator");

  // Plan: the coordinator's version is there with the task it added, as the coordinator's, not the person's.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Confirmed plan: revision 2")).toBeVisible();
  await expect(page.getByRole("article", { name: "Check each claim in the brief against its source" })).toBeVisible();
  await shot(page, "5-plan-revised");

  // A finished task wakes the coordinator again; it re-plans inside the policy, and the mission finishes by itself after it.
  await drive(governor, sessions, () => plans().length >= 3, 180_000);
  expect(plans().map((entry) => `${entry.revision}:${entry.state}:${entry.origin}`)).toEqual(["1:superseded:template", "2:superseded:agent", "3:confirmed:agent"]);
  await drive(governor, sessions, () => (db.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string }).state !== "active", 180_000);
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/timeline`);
  await expect(page.getByText("The coordinator ran").first()).toBeVisible();
  await shot(page, "6-timeline");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "Timeline accessibility").toEqual([]);
  expect(errors).toEqual([]);
});
