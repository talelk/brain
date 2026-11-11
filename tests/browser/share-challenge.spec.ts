import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// A first-time owner shares one verified result as a read-only link, opens it as a stranger with no account, withdraws it, and
// asks for an independent re-check of a task's result, whose findings stay claims beside the result.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `share-${name}.png`), fullPage: true });
};

test("a result is shared as a read-only link, read without an account, and withdrawn; a challenge adds claims, never a verdict", async ({ page, governor, browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Share organization");
  await page.getByLabel(/^Email/).fill("share@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-share", slug: "share" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-share")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-share", org: actor.organizationId } as unknown as TestWorld;
  const missionId = await achievedMission(world, "share", {
    title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes"],
    outputs: [{ name: "churn-report.md", text: "# Churn report\n\nPricing confusion drove most cancellations.\n\n- Slow onboarding came second\n- Missing integrations third" }],
  });
  const ws = brain.store.workspaceDb("ws-share", actor.organizationId);
  // Named outputs open on `/outputs/output-…`; the helper's ids are shorter, and it registers only the workspace's artifact row.
  ws.pragma("foreign_keys = OFF");
  ws.prepare("UPDATE output_versions SET output_id='output-share-0' WHERE output_id='out-share-0'").run();
  ws.prepare("UPDATE mission_outputs SET id='output-share-0' WHERE id='out-share-0'").run();
  ws.pragma("foreign_keys = ON");
  const artifact = ws.prepare("SELECT id, digest FROM artifacts WHERE id='art-share-0'").get() as { id: string; digest: string };
  brain.store.control.prepare("INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(artifact.id, actor.organizationId, "ws-share", artifact.digest, "job", "job-share", "internal", Date.now());

  // 1. The owner creates a link for the verified result and is told it is shown once.
  await page.goto(`${governor.url}/outputs/output-share-0?w=ws-share`);
  await page.getByRole("button", { name: "Share a read-only link", exact: true }).click();
  const panel = page.getByTestId("share-panel");
  await expect(panel).toContainText("cannot change anything");
  await panel.getByRole("button", { name: "Create link", exact: true }).click();
  const created = page.getByTestId("share-created");
  await expect(created).toContainText("Brain will not show it again");
  const url = (await created.getByTestId("share-url").textContent()) ?? "";
  expect(url).toMatch(/\/shared\/[A-Za-z0-9_-]{43}$/u);
  await shot(page, "1-created");

  // 2. A stranger with no cookies opens it: the result and nothing else, no navigation, nothing to act on.
  const stranger = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await stranger.newPage();
  const guestErrors: string[] = [];
  guest.on("pageerror", (error) => guestErrors.push(error.message));
  await guest.goto(url);
  await expect(guest.getByRole("heading", { name: "churn-report.md", level: 1 })).toBeVisible();
  await expect(guest.getByTestId("shared-result")).toContainText("Pricing confusion drove most cancellations");
  await expect(guest.getByTestId("shared-result")).toContainText("read only");
  await expect(guest.getByRole("navigation")).toHaveCount(0);
  await expect(guest.getByRole("button", { name: /accept|reject|approve|start|delete|save/i })).toHaveCount(0);
  await expect(guest.getByTestId("shared-result")).not.toContainText("Quarterly churn report");
  expect((await stranger.cookies()).length).toBe(0);
  await shot(guest, "2-shared-view");
  const accessibility = await new AxeBuilder({ page: guest }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"), "shared page accessibility").toEqual([]);
  // The page itself is the only thing the link opens: the app is not reachable with it.
  await guest.goto(`${governor.url}/w/ws-share/missions`);
  await expect(guest.getByLabel(/^Email/)).toBeVisible();

  // 3. The owner sees the link listed, withdraws it, and the stranger is told it is gone.
  await page.reload();
  await page.getByRole("button", { name: "Share a read-only link", exact: true }).click();
  const list = page.getByTestId("share-list");
  await expect(list).toContainText("Active");
  await expect(list).toContainText("opened 1 time");
  await list.getByRole("button", { name: "Withdraw link", exact: true }).click();
  await expect(list).toContainText("Withdrawn");
  await guest.goto(url);
  await expect(guest.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
  await expect(guest.getByTestId("shared-result")).toContainText("withdrew this link");
  await shot(guest, "3-withdrawn");
  await stranger.close();
  expect(guestErrors).toEqual([]);

  // 4. Challenge this result: a reviewer run is requested through the governed path; its answer becomes claims, never a verdict.
  const item = ws.prepare("SELECT id, state, version FROM work_items WHERE mission_id=?").get(missionId) as { id: string; state: string; version: number };
  expect(item.state).toBe("done");
  // The finished task's written result, as the run that did the work stored it.
  ws.prepare("INSERT INTO workflow_runs(id, execution_key, config_digest, workflow_digest, adapter_digest, engine_run_id, state, input_digest, created_at_ms) VALUES ('run-author','exec-author',?,?,?,'eng-author','succeeded',?,?)")
    .run(`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `sha256:${"4".repeat(64)}`, Date.now());
  ws.prepare("INSERT INTO execution_links(mission_id, work_item_id, run_id, created_at_ms) VALUES (?,?,?,?)").run(missionId, item.id, "run-author", Date.now());
  ws.prepare("INSERT INTO step_outputs(run_id, step_id, output_json) VALUES ('run-author','respond',?)").run(JSON.stringify({ summary: "Pricing drove churn.", deliverable: "# Churn report\n\nPricing confusion drove most cancellations, according to the export.", criteria: [], assumptions: [] }));
  const verdictBefore = JSON.stringify(ws.prepare("SELECT state, evidence_digest, version FROM work_items WHERE id=?").get(item.id));
  await page.goto(`${governor.url}/outputs/output-share-0?w=ws-share`);
  const challenge = page.getByTestId("challenge").first();
  await expect(challenge).toContainText("one model's opinion");
  await challenge.getByRole("button", { name: "Challenge this result", exact: true }).click();
  await expect(challenge.getByRole("button", { name: /Reviewer is reading/ })).toBeVisible();
  await shot(page, "4-challenge-running");
  const row = await expect.poll(() => ws.prepare("SELECT run_id FROM result_challenges WHERE work_item_id=?").get(item.id) as { run_id: string | null } | undefined, { timeout: 20_000 }).toMatchObject({ run_id: expect.any(String) }).then(() => ws.prepare("SELECT run_id FROM result_challenges WHERE work_item_id=?").get(item.id) as { run_id: string });
  // The reviewer run finishes (a real run needs a runner; here its stored answer is written the way the engine would).
  ws.prepare("UPDATE workflow_runs SET state='succeeded' WHERE id=?").run(row.run_id);
  ws.prepare("INSERT INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(row.run_id, "respond", JSON.stringify({ summary: "One point needs a figure.", assumptions: [], criteria: [], deliverable: "# Review\n\n- The claim that pricing confusion drove most cancellations has no figure behind it.\n\nNothing else stood out." }));
  await governor.app.brain.challenges.sweep();
  await expect(challenge.getByTestId("challenge-claims")).toContainText("no figure behind it", { timeout: 15_000 });
  await expect(challenge.getByTestId("challenge-result")).toContainText("model opinion");
  await shot(page, "5-challenge-claims");
  // Never a verdict: the task is exactly as verified as before.
  expect(JSON.stringify(ws.prepare("SELECT state, evidence_digest, version FROM work_items WHERE id=?").get(item.id))).toBe(verdictBefore);
  expect(errors).toEqual([]);
});
