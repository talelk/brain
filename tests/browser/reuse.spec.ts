import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// A first-time owner's whole reuse loop in the real app: a finished mission writes up what it
// learned, the owner approves it once, search finds it as local approved knowledge, and the next
// similar mission is offered it before the plan is drafted and says afterwards what it reused.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

test("reuse loop: approve once, find it in search, get it offered before planning, see what was reused", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Reuse organization");
  await page.getByLabel(/^Email/).fill("reuse@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-reuse", slug: "reuse" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-reuse")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-reuse", org: actor.organizationId } as unknown as TestWorld;
  const past = await achievedMission(world, "past", {
    title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes",
    criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"],
    outputs: [{ name: "churn-report.md", text: "# Churn report\nPricing confusion drove most cancellations, then slow onboarding, then missing integrations." }],
    decision: "Use the finance export as the data source", rejectedFindings: ["The first draft cited no source for cause two"],
  });
  const db = brain.store.workspaceDb("ws-reuse", actor.organizationId);

  // 1. The Review inbox shows a readable record, not JSON, and one click publishes it.
  await page.goto(`${governor.url}/w/ws-reuse/knowledge/review`);
  const proposal = page.locator('[data-testid^="knowledge-proposal-"]').first();
  await expect(page.getByRole("heading", { name: /Review inbox/ }).first()).toBeVisible();
  await expect(proposal).toContainText("Quarterly churn report");
  await expect(proposal).toContainText("Awaiting review");
  await expect(proposal.getByTestId("knowledge-proposal-text")).toContainText("Success criteria and how each was checked");
  await expect(proposal.getByTestId("knowledge-proposal-text")).toContainText("The first draft cited no source for cause two");
  await expect(proposal.getByTestId("knowledge-proposal-text")).not.toContainText('"kind"');
  await shot(page, "1-review-inbox");
  await proposal.getByRole("button", { name: "Approve and publish", exact: true }).click();
  await expect(proposal).toContainText("Published");
  await expect(proposal).toContainText("Self-reviewed");
  await shot(page, "2-published");

  // 2. Search finds it, labelled as the local store with approved, self-reviewed knowledge.
  await page.goto(`${governor.url}/w/ws-reuse/knowledge`);
  await page.getByLabel("Search scoped knowledge").fill("quarterly churn causes");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Approved knowledge", { exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-store-label")).toContainText("Local store");
  await expect(page.getByText("Knowledge service is degraded")).toHaveCount(0);
  await expect(page.getByText("Self-reviewed", { exact: true }).first()).toBeVisible();
  await shot(page, "3-search");

  // 3. A similar new mission is offered the past work before the plan is drafted.
  await page.goto(`${governor.url}/w/ws-reuse/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByRole("button", { name: /Describe what you want/ }).click();
  await form.getByLabel(/^What do you want done/).fill("Write the quarterly churn report for the board");
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/plan/);
  const suggestions = page.getByTestId("reuse-suggestions");
  await expect(suggestions).toContainText("Brain found");
  await expect(suggestions).toContainText("Quarterly churn report");
  await expect(suggestions).toContainText("last verified");
  await expect(suggestions).toContainText("not used yet");
  const count = await page.getByTestId("reuse-suggestion").count();
  expect(count).toBeGreaterThanOrEqual(2);
  await shot(page, "4-suggestions");
  const missionId = (db.prepare("SELECT id FROM missions WHERE title LIKE 'Write the quarterly%'").get() as { id: string }).id;
  // Nothing is attached, and no draft has started, until the person decides.
  expect(db.prepare("SELECT COUNT(*) AS n FROM reuse_attachments WHERE mission_id=?").get(missionId)).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM planning_requests WHERE mission_id=?").get(missionId)).toEqual({ n: 0 });

  // 4. Drop the verified output, keep the rest, draft the plan.
  await suggestions.getByRole("checkbox", { name: /Use churn-report\.md/ }).uncheck();
  await suggestions.getByRole("button", { name: /^Draft the plan with/ }).click();
  await expect.poll(() => db.prepare("SELECT COUNT(*) AS n FROM planning_requests WHERE mission_id=?").get(missionId)).toEqual({ n: 1 });
  const decisions = db.prepare("SELECT item_ref, decision, used FROM reuse_attachments WHERE mission_id=? ORDER BY item_ref").all(missionId) as Array<{ item_ref: string; decision: string; used: number }>;
  expect(decisions.find((row) => row.item_ref === `mission:${past}`)).toMatchObject({ decision: "kept", used: 1 });
  expect(decisions.find((row) => row.item_ref.startsWith("output:"))).toMatchObject({ decision: "dropped", used: 0 });
  // The planner's input carries the kept items as claims with provenance, and not the dropped one.
  const inputs = (db.prepare("SELECT input_json FROM run_inputs").all() as Array<{ input_json: string }>).map((row) => row.input_json).join("\n");
  expect(inputs).toContain("not evidence");
  expect(inputs).toContain("Quarterly churn report");
  expect(inputs).not.toContain("Pricing confusion drove most cancellations");

  // 5. The Outputs tab says what Brain reused, from the stored records, and Remove is one click.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs?w=ws-reuse`);
  const line = page.getByTestId("reused-line");
  await expect(line).toContainText("Reused:");
  await expect(line).toContainText("Quarterly churn report");
  await expect(line).toContainText("used once");
  await shot(page, "5-reused-line");
  await line.getByRole("button", { name: /^Stop reusing Quarterly churn report/ }).first().click();
  await expect(page.getByTestId("reused-line").getByText("will not be offered to this mission again")).toBeVisible();
  expect(db.prepare("SELECT COUNT(*) AS n FROM reuse_attachments WHERE mission_id=? AND decision='dropped'").get(missionId)).toEqual({ n: 2 });
  // 6. The brief records what was kept or dropped and by whom.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/brief?w=ws-reuse`);
  await expect(page.getByTestId("brief-reused")).toContainText("dropped by you");
  await expect(page.getByTestId("brief-reused")).toContainText("Quarterly churn report");
  await shot(page, "6-brief");
  expect(errors).toEqual([]);
});
