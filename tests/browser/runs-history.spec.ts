import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { Mission } from "@brain/contracts";
import { fixtureStarter } from "../support/starter";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { signUpOwner } from "../support/flow";

/**
 * Logs > Runs reads like Today (rows 70 and 71): a failed attempt of a task that a later attempt finished is history, shown as
 * "Retried and succeeded"; only a run nothing has settled sits under Needs intervention, and every row names its task and mission,
 * not a raw job id.
 */
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${test.info().project.name}.png`, fullPage: true }); };

test("Needs intervention lists only unresolved runs, named by task and mission", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor } = await signUpOwner(page, governor, "runs");
  brain.createWorkspace(actor, { workspaceId: "ws-runs", slug: "runs" });
  const starter = fixtureStarter();
  const release = brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest;
  brain.activateRelease(actor, release);
  const ws = { ...actor, workspaceId: "ws-runs", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-runs") };
  const db = brain.store.workspaceDb("ws-runs", actor.organizationId);
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-runs", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const version = async (id: string) => ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-runs", resourceId: id })) as unknown as { snapshot: Mission }).snapshot.version;
  const mission = async (key: string, title: string, taskTitle: string): Promise<{ missionId: string; workItemId: string }> => {
    const missionId = (await cmd("mission.create", `${key}-create`, { title, intent: `${title} intent`, successCriteria: ["done"], autoStart: false })).resourceId ?? "";
    const plan = (await cmd("plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [{ id: "t", title: taskTitle, criteria: ["The note exists"], dependsOn: [] }] })).resourceId ?? "";
    await cmd("plan.confirm", `${key}-confirm`, { planVersionId: plan }, await version(missionId));
    return { missionId, workItemId: (db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id };
  };
  const job = (id: string, runId: string, state: string, createdAt: number) => brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,version,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms)
    VALUES (?,?,'ws-runs',?,?,'respond',?,1,?,?,?,'read',?,?,?)`).run(id, actor.organizationId, `exec-${id}`, runId, state, release,
    JSON.stringify({ resources: { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 }, all: [] }), `sha256:${"d".repeat(64)}`, createdAt, createdAt, createdAt + 60_000);

  const healed = await mission("healed", "Note-taking mission", "Compile the candidate tools");
  const stuck = await mission("stuck", "Offsite mission", "Collect the quotes");
  const now = Date.now();
  brain.missions.linkExecution(ws, "ws-runs", healed.workItemId, "run-h1"); job("job-healed-1", "run-h1", "failed", now - 600_000);
  brain.missions.linkExecution(ws, "ws-runs", healed.workItemId, "run-h2"); job("job-healed-2", "run-h2", "succeeded", now - 300_000);
  db.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"a".repeat(64)}`, healed.workItemId);
  db.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(healed.missionId);
  brain.missions.linkExecution(ws, "ws-runs", stuck.workItemId, "run-s1"); job("job-stuck-1", "run-s1", "failed", now - 120_000);
  db.prepare("UPDATE work_items SET state='blocked', parked=1, parked_diagnostic='The model could not reach the source', blocked_reason='Parked after 3 failed attempts' WHERE id=?").run(stuck.workItemId);

  await page.goto(`${governor.url}/w/ws-runs/logs?view=runs`);
  // Today's Needs-you queue and the Runs count agree: one thing, the parked task.
  const summary = page.getByRole("group", { name: "Runs summary" }).or(page.locator('dl[aria-label="Runs summary"]'));
  await expect(summary).toContainText("Needs intervention1");
  await page.getByRole("button", { name: "Needs intervention", exact: true }).click();
  const rows = page.locator(".brain-queue-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Collect the quotes · Offsite mission");
  await expect(rows.first()).toContainText("job-stuck-1");
  await expect(rows.first()).not.toContainText("Do a task");
  await page.waitForTimeout(800);
  await shot(page, "runs-intervention");

  await page.getByRole("button", { name: "History", exact: true }).click();
  const retried = rows.filter({ hasText: "Compile the candidate tools · Note-taking mission" });
  await expect(retried).toHaveCount(2);
  await expect(retried.filter({ hasText: "Retried and succeeded" })).toHaveCount(1);
  await expect(retried.filter({ hasText: "Retried and succeeded" })).toContainText("finished by a later attempt");
  await page.waitForTimeout(800);
  await shot(page, "runs-history");

  await page.goto(`${governor.url}/w/ws-runs/today`);
  await expect(page.getByText("Collect the quotes").first()).toBeVisible();
  await expect(page.getByText("Compile the candidate tools")).toHaveCount(0);

  // The run inspector header names the task and mission and keeps the id copyable.
  await page.goto(`${governor.url}/runs/job-healed-1`);
  await expect(page.getByRole("heading", { name: "Compile the candidate tools · Note-taking mission" })).toBeVisible();
  await expect(page.getByText("Retried and succeeded: a later attempt finished this task.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy full run id" })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "run-inspector");
  expect(errors).toEqual([]);
});
