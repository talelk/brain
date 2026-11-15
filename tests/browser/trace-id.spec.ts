import { test, expect } from "./fixtures";
import type { Mission } from "@brain/contracts";
import { fixtureStarter } from "../support/starter";
import { missionTraceId } from "../../apps/governor/src/domain/trace";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { signUpOwner } from "../support/flow";

/**
 * The mission trace id (spec #90, story 93), walked as a first-time person: start a mission in the real form, open its Brief from More
 * views, open Trace id, read and copy it; then the run page of one of its runs shows the same id under Technical references.
 */
test("a person finds and copies the mission trace id on the mission and the run page", async ({ page, governor, context }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor } = await signUpOwner(page, governor, "trace");
  brain.createWorkspace(actor, { workspaceId: "ws-trace", slug: "trace" });
  const starter = fixtureStarter();
  const release = brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest;
  brain.activateRelease(actor, release);
  const db = brain.store.workspaceDb("ws-trace", actor.organizationId);

  await page.goto(`${governor.url}/w/ws-trace/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill("Follow one mission through a collector");
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (db.prepare("SELECT id FROM missions WHERE title LIKE ?").get("Follow one mission%") as { id: string }).id;
  const trace = missionTraceId(missionId);

  // From the mission's main view: More views, then the Brief, then Trace id.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/live`);
  await page.getByRole("button", { name: "More views" }).click();
  await page.getByRole("menuitem", { name: "Brief" }).click();
  await expect(page).toHaveURL(/\/brief/);
  await page.getByText("Trace id", { exact: true }).click();
  await expect(page.getByText(trace)).toBeVisible();
  await page.getByRole("button", { name: "Copy full Trace id" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(trace);
  await page.waitForTimeout(800);
  await page.screenshot({ path: test.info().outputPath("brief-trace.png"), fullPage: true });

  // A run of that mission shows the same id.
  const ws = { ...actor, workspaceId: "ws-trace", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-trace") };
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-trace", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const plan = (await cmd("plan.propose", "trace-plan", { missionId, origin: "manual", tasks: [{ id: "t", title: "Write the note", criteria: ["The note exists"], dependsOn: [] }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-trace", resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await cmd("plan.confirm", "trace-confirm", { planVersionId: plan }, version);
  const workItemId = (db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
  brain.missions.linkExecution(ws, "ws-trace", workItemId, "run-trace-1");
  const now = Date.now();
  brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,version,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms)
    VALUES ('job-trace-1',?,'ws-trace','exec-trace-1','run-trace-1','respond','failed',1,?,?,?,'read',?,?,?)`).run(actor.organizationId, release,
    JSON.stringify({ resources: { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 }, all: [] }), `sha256:${"d".repeat(64)}`, now, now, now + 60_000);
  await page.goto(`${governor.url}/runs/job-trace-1`);
  await page.getByText("Technical references", { exact: true }).click();
  await expect(page.getByText(trace)).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: test.info().outputPath("run-trace.png"), fullPage: true });
  expect(errors).toEqual([]);
});
