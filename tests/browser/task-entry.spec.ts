import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { join } from "node:path";

test("guided task entry: persisted modes, shared review, timeout recovery, console handoff and execution links", async ({ page, governor }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const brain = governor.app.brain;
  const response = await page.request.post(`${governor.url}/v1/setup`, { headers: { authorization: `Setup ${governor.credential}` }, data: { email: "tasks@example.test", password: "task-entry-password-123", name: "Task entry", organizationId: "org-local" } });
  expect(response.status()).toBe(201); const boot = await response.json();
  const identity = await brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }));
  brain.createWorkspace(identity.actor, { workspaceId: "operations", slug: "My workspace" });
  const bundle = fixtureStarter(); const release = brain.stageRelease(identity.actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas); brain.activateRelease(identity.actor, release.digest);
  const sessions = [];
  for (const group of ["agents", "evaluators"]) {
    const cfg = { governorUrl: governor.url, runnerId: `entry-${group}`, stateDir: join(brain.store.dataDir, group), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    sessions.push({ cfg, ...await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(identity.actor, group).token) });
  }
  const db = brain.store.workspaceDb("operations", identity.actor.organizationId);

  // The guided rail: landing on Start work with the persisted catalog mode
  // puts the published-recipe selection forward as the current step.
  await page.goto(`${governor.url}/w/operations/workflows`);
  await expect(page.locator('ol[aria-label="Guided steps"] [aria-current="step"]')).toHaveText(/Recipe/);
  await page.getByRole("button", { name: /From a work item/ }).click();
  await expect(page).toHaveURL(/mode=work/);
  await page.goto(`${governor.url}/w/operations/workflows`);
  await expect(page.getByRole("button", { name: /From a work item/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Advance an existing item", exact: true })).toBeVisible();

  // Describe-the-work mode: the conversation proposes a recipe for review and
  // never dispatches by itself; the rail advances to review only with a draft.
  await page.goto(`${governor.url}/w/operations/workflows?mode=ask`);
  await expect(page.locator('ol[aria-label="Guided steps"] [aria-current="step"]')).toHaveText(/Start/);
  await page.getByLabel(/^Your request/).fill("Draft a support reply about an expired session");
  await page.getByRole("button", { name: "Send request", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/conversation=/);
  const firstConversationUrl = page.url();
  expect((db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(1);
  for (const session of sessions) expect(await runOnce(session.cfg, session.sessionToken, session.epoch)).toBe(true);
  await page.getByRole("button", { name: "Review proposed task", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review before starting", exact: true })).toBeVisible();
  await expect(page.locator('ol[aria-label="Guided steps"] [aria-current="step"]')).toHaveText(/Review & dispatch/);
  expect((db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(1);
  let timedOut = false;
  await page.route("**/v1/tasks/drafts/*/start", async (route) => { if (!timedOut) { timedOut = true; await route.fetch(); await route.abort("timedout"); } else await route.continue(); });
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("recovers its existing run");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.waitForURL(/\/jobs\//);
  expect((db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(2);
  for (const session of sessions) expect(await runOnce(session.cfg, session.sessionToken, session.epoch)).toBe(true);
  await page.reload(); await expect(page.getByRole("heading", { name: "Structured output", exact: true })).toBeVisible();

  // Work-item origin: the guided flow seeds the item context, dispatches with
  // the link preserved, and the panel resolves console/logs/outputs deep links
  // from the execution link once the attempt binds its session.
  const seedNow = Date.now();
  db.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-entry','Entry objective','Entry intent','[]',?, ?, ?)").run(identity.actor.actorId, seedNow, seedNow);
  db.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-entry','obj-entry',1,?,'confirmed','manual',?,'[]',?)").run(`sha256:${"b".repeat(64)}`, identity.actor.actorId, seedNow);
  db.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('entry-card','obj-entry','plan-entry','investigate','Investigate latency','ready','[]','Start this task',?,?)").run(seedNow, seedNow);
  await page.goto(`${governor.url}/w/operations/plans?mission=obj-entry`);
  await page.getByRole("button", { name: "Manage Investigate latency" }).click();
  await page.getByRole("button", { name: "Start a task for this item", exact: true }).click();
  await expect(page.getByLabel(/^Situation/)).toHaveValue(/Investigate latency/);
  await expect(page.locator('ol[aria-label="Guided steps"] [aria-current="step"]')).toHaveText(/Review & dispatch/);
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click(); await page.waitForURL(/\/jobs\//);
  for (const session of sessions) expect(await runOnce(session.cfg, session.sessionToken, session.epoch)).toBe(true);
  await page.goto(`${governor.url}/w/operations/plans?mission=obj-entry`); await page.getByRole("button", { name: "Manage Investigate latency" }).click();
  await expect(page.getByRole("button", { name: "Inspect run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Console", exact: true })).toBeVisible();
  await expect(page.locator("#app-shell-content").getByRole("button", { name: "Logs", exact: true })).toBeVisible();
  await expect(page.locator("#app-shell-content").getByRole("button", { name: "Outputs", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/operations\/live\?session=/);

  // Catalog mode: published recipes only — system definitions stay hidden.
  await page.goto(`${governor.url}/w/operations/workflows?mode=catalog`);
  await expect(page.getByRole("region", { name: "Task catalog", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Ask Brain" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Verify installation" })).toHaveCount(0);

  await page.goto(`${governor.url}/settings?tab=health`);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download diagnostics", exact: true }).click();
  const download = await downloading; const reportPath = info.outputPath("diagnostics.json"); await download.saveAs(reportPath);
  const report = readFileSync(reportPath, "utf8");
  expect(JSON.parse(report).format).toBe("brain.redacted-diagnostics/v1");
  expect(report).not.toContain("task-entry-password-123"); expect(report).not.toContain(boot.sessionToken);

  await page.goto(firstConversationUrl);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByLabel(/^Your request/).fill("Investigate a new operational issue");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page).toHaveURL(/conversation=/);
  expect(new URL(page.url()).searchParams.get("conversation")).not.toBe(new URL(firstConversationUrl).searchParams.get("conversation"));
  expect((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n).toBe(2);
  await info.attach("shared-task-entry", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
