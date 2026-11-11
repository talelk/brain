import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// Capitalisation and reuse without chores (backlog rows 47 to 50): verified write-ups publish themselves, marked and
// undoable; with the setting off one click approves them all; the ready-made Plays are one click away.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `hands-off-${name}.png`), fullPage: true });
};

const REPORT = {
  summary: "Pricing confusion drove most cancellations; two plans overlap and the renewal email hides the price.",
  deliverable: "# Churn causes\n\n1. Pricing confusion (finance export).\n2. Missing onboarding follow-up (support tickets).\n3. A competitor discount in March (sales notes).\n\nEach cause cites its data source.",
  criteria: [{ criterion: "The report names the biggest causes", met: true, evidence: "Causes 1 to 3 are named" }],
  assumptions: ["Churn means cancelled paid plans in the quarter"],
};

async function workspace(page: Page, governor: Parameters<Parameters<typeof test>[2]>[0]["governor"], options: { withPlays: boolean }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Hands-off organization");
  await page.getByLabel(/^Email/).fill("handsoff@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-ho", slug: "handsoff" });
  const bundle = fixtureStarter();
  const documents = options.withPlays ? bundle.documents : bundle.documents.filter((doc) => !doc.path.startsWith("config/plays/"));
  brain.activateRelease(actor, brain.stageRelease(actor, documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-ho")).actor;
  return { brain, world: { brain, owner: scoped, workspaceId: "ws-ho", org: actor.organizationId } as unknown as TestWorld };
}

test("a verified write-up publishes itself, Today says so quietly, and Withdraw undoes it", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { world } = await workspace(page, governor, { withPlays: true });
  await achievedMission(world, "past", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"], report: REPORT, autoPublish: true });

  await page.goto(`${governor.url}/w/ws-ho/today`);
  const line = page.getByTestId("knowledge-line");
  await expect(line).toContainText("Brain learned 1 thing this week (1 on its own).");
  await expect(line.getByRole("button", { name: "Approve all verified" })).toHaveCount(0);
  await shot(page, "1-today");

  await page.goto(`${governor.url}/w/ws-ho/library`);
  await expect(page.getByTestId("library-count-review")).toHaveText("0");
  await expect(page.getByTestId("library-count-knowledge")).toHaveText("1");
  await expect(page.getByRole("checkbox", { name: "Publish verified write-ups automatically" })).toBeChecked();
  await shot(page, "2-library");

  await page.getByTestId("library-shelf-review").click();
  const card = page.locator('[data-testid^="knowledge-proposal-"]').first();
  await expect(card).toContainText("Published automatically");
  await expect(card).toContainText("Self-reviewed");
  await expect(card.getByTestId("knowledge-proposal-text")).toContainText("Pricing confusion drove most cancellations");
  await expect(card.getByTestId("knowledge-proposal-text")).toContainText("Worker's report: met");
  await shot(page, "3-published-card");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "Review inbox accessibility").toEqual([]);

  await card.getByRole("button", { name: /Withdraw/ }).click();
  await expect(card).toContainText("revoked");
  await page.goto(`${governor.url}/w/ws-ho/today`);
  await expect(page.getByTestId("knowledge-line")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("with automatic publishing off, Today offers one click to approve every verified write-up", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const { world } = await workspace(page, governor, { withPlays: true });
  await achievedMission(world, "a", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"], report: REPORT });
  await achievedMission(world, "b", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", criteria: ["A plan is recommended"], report: REPORT });

  await page.goto(`${governor.url}/w/ws-ho/library`);
  await expect(page.getByRole("checkbox", { name: "Publish verified write-ups automatically" })).not.toBeChecked();
  await expect(page.getByTestId("library-count-review")).toHaveText("2");

  await page.goto(`${governor.url}/w/ws-ho/today`);
  const line = page.getByTestId("knowledge-line");
  await expect(line).toContainText("2 write-ups wait for your OK.");
  await shot(page, "4-today-waiting");
  await line.getByRole("button", { name: "Approve all verified" }).click();
  await expect(page.getByTestId("knowledge-line")).toContainText("Brain learned 2 things this week");
  await expect(page.getByTestId("knowledge-line")).not.toContainText("wait for your OK");

  // The same setting turned back on is one tick on the Library overview.
  await page.goto(`${governor.url}/w/ws-ho/knowledge/review`);
  await expect(page.getByTestId("approve-all-verified")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Publish verified write-ups automatically" }).check();
  await expect(page.getByTestId("auto-publish-setting")).toContainText("On. Verified write-ups now publish themselves.");
});

test("Approve all verified on the Review inbox publishes the waiting write-ups", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const { world } = await workspace(page, governor, { withPlays: true });
  await achievedMission(world, "a", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"], report: REPORT });
  await achievedMission(world, "b", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", criteria: ["A plan is recommended"], report: REPORT });
  await page.goto(`${governor.url}/w/ws-ho/knowledge/review`);
  await expect(page.getByTestId("approve-all-verified")).toContainText("Approve all verified (2)");
  await shot(page, "5-inbox-waiting");
  await page.getByTestId("approve-all-verified").click();
  await expect(page.getByTestId("approve-all-verified")).toHaveCount(0);
  await expect(page.locator('[data-testid^="knowledge-proposal-"]').first()).toContainText("Published");
});

test("Add starter Plays: one click puts six ready-made Plays on Today and in the Library", async ({ page, governor }) => {
  test.setTimeout(180_000);
  await workspace(page, governor, { withPlays: false });
  await page.goto(`${governor.url}/w/ws-ho/today`);
  const chips = page.getByTestId("play-chips");
  await expect(chips.getByRole("button", { name: "Add starter Plays" })).toBeVisible();
  await shot(page, "6-today-no-plays");
  await chips.getByRole("button", { name: "Add starter Plays" }).click();
  const titles = ["Write a checklist or runbook", "Compare options and recommend one", "Triage an incident", "Research and write a brief", "Draft a customer support reply", "Weekly status update"];
  const phone = (page.viewportSize()?.width ?? 1440) < 640;
  // A phone shows the first three behind "3 more Plays"; wider screens show all six.
  for (const [index, title] of titles.entries()) await expect(chips.getByRole("button", { name: title, exact: true })).toBeVisible({ visible: !phone || index < 3 });
  if (phone) await expect(chips.getByRole("button", { name: "3 more Plays" })).toBeVisible();
  // The box stays blocked until the install is ready (no runners in this test), so the chips are shown but not usable yet.
  await shot(page, "7-today-plays");

  await page.goto(`${governor.url}/w/ws-ho/plays`);
  await expect(page.getByRole("button", { name: "Open play Triage an incident" })).toBeVisible();
  await expect(page.getByRole("button", { name: /starter Plays?$/ })).toHaveCount(0);
  await shot(page, "8-plays");
  await page.getByRole("button", { name: "Open play Weekly status update" }).click();
  await expect(page.getByRole("heading", { name: "Weekly status update", level: 1 })).toBeVisible();
  await shot(page, "9-play");
});

test("the Library places stay on one scrollable row on a phone", async ({ page, governor }, testInfo) => {
  test.setTimeout(120_000);
  await workspace(page, governor, { withPlays: true });
  await page.goto(`${governor.url}/w/ws-ho/library`);
  await expect(page.getByRole("radiogroup", { name: "Library places" })).toBeVisible();
  const tops = await page.getByRole("radiogroup", { name: "Library places" }).getByRole("radio").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tops).size, "all Library places sit on one row").toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page does not scroll sideways").toBeLessThanOrEqual(1);
  void testInfo;
  await shot(page, "10-library-tabs");
});
