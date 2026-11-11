import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// Track AB (backlog 68, 69): the Library overview counts only what truly needs a person as "Awaiting your review"; what Brain
// published itself (a hands-off mission the Governor closed included) is counted apart as "Published automatically".
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `needs-person-${name}.png`), fullPage: true });
};

const REPORT = {
  summary: "Pricing confusion drove most cancellations; two plans overlap and the renewal email hides the price.",
  deliverable: "# Churn causes\n\n1. Pricing confusion (finance export).\n2. Missing onboarding follow-up (support tickets).\n3. A competitor discount in March (sales notes).\n\nEach cause cites its data source.",
  criteria: [{ criterion: "The report names the biggest causes", met: true, evidence: "Causes 1 to 3 are named" }],
  assumptions: ["Churn means cancelled paid plans in the quarter"],
};

test("the Library overview separates what needs a person from what Brain published itself", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Needs person organization");
  await page.getByLabel(/^Email/).fill("needsperson@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-np", slug: "needsperson" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-np")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-np", org: actor.organizationId } as unknown as TestWorld;

  // Two missions the Governor closed by itself while the owner was the only reviewer: both publish themselves.
  await achievedMission(world, "h1", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"], report: REPORT, autoPublish: true, handsOff: true });
  await achievedMission(world, "h2", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", criteria: ["A plan is recommended"], report: REPORT, autoPublish: true, handsOff: true });
  await page.goto(`${governor.url}/w/ws-np/library`);
  await expect(page.getByTestId("library-count-review")).toHaveText("0");
  await expect(page.getByTestId("library-count-auto")).toHaveText("2");
  await shot(page, "1-all-automatic");

  // A second reviewer joins: the next hands-off write-up needs a person, and only that is awaiting review.
  brain.ensurePrincipal(actor.organizationId, "reviewer-2", "human");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'workspace-lead',1,?,?)").run("ws-np", actor.organizationId, "reviewer-2", actor.actorId, brain.store.now());
  await achievedMission(world, "h3", { title: "Onboarding check", intent: "Check the onboarding checklist for gaps in the first week", criteria: ["Gaps listed"], report: REPORT, autoPublish: true, handsOff: true });
  await page.goto(`${governor.url}/w/ws-np/library`);
  await expect(page.getByTestId("library-count-review")).toHaveText("1");
  await expect(page.getByTestId("library-count-auto")).toHaveText("2");
  await expect(page.getByTestId("library-count-knowledge")).toHaveText("2");
  await expect(page.getByTestId("library-shelf-review")).toContainText("1 write-up");
  await expect(page.getByTestId("library-shelf-auto")).toContainText("Published automatically");
  await shot(page, "2-one-needs-a-person");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "Library accessibility").toEqual([]);

  await page.getByTestId("library-shelf-review").click();
  await expect(page.getByTestId("approve-all-verified")).toContainText("Approve all verified (1)");
  await expect(page.locator('[data-testid^="knowledge-proposal-"]').filter({ hasText: "Published automatically" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
