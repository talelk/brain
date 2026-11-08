import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { Brain } from "../../apps/governor/src/application/brain";
import { fixtureStarter } from "../support/starter";

const DIGEST = `sha256:${"a".repeat(64)}`;
interface GovernorFixture { url: string; credential: string; app: { brain: Brain } }

async function world(page: Page, governor: GovernorFixture, workspaceId = "ws-edge") {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Authority edge organization");
  await page.getByLabel(/^Email/).fill("authority-edge@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const actor = (await brain.resolveActor(new Headers({ cookie: (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId, slug: "Edge workspace" });
  for (const role of ["operator", "approver"]) brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,?,1,?,?)").run(workspaceId, actor.organizationId, actor.actorId, role, actor.actorId, brain.store.now());
  return { brain, actor, ws: brain.store.workspaceDb(workspaceId, actor.organizationId) };
}

test("approval conflict keeps the reviewed note and requires a fresh exact review", async ({ page, governor }) => {
  const { brain, actor } = await world(page, governor);
  brain.ensurePrincipal(actor.organizationId, "edge-requester", "human");
  const now = brain.store.now();
  const subject = { organizationId: actor.organizationId, workspaceId: "ws-edge", operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST }, inputDigest: DIGEST, target: { targetId: "edge-target", environmentId: "production", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST, effectBounds: { publication: "Exact reviewed response" }, expiresAt: new Date(now + 3600_000).toISOString(), nonce: "edge-conflict" };
  const approvalId = brain.createApprovalForGate({ organizationId: actor.organizationId, workspaceId: "ws-edge", runId: "edge-run", stepId: "publish", subject, expiresAtMs: now + 3600_000, requestedBy: "edge-requester" });
  await page.goto(`${governor.url}/approvals/${approvalId}`);
  await page.getByRole("button", { name: "Review action", exact: true }).click();
  await page.getByLabel(/^Decision note/).fill("Preserve this note across the conflict");
  brain.store.control.prepare("UPDATE approval_requests SET version=2 WHERE id=?").run(approvalId);
  await page.getByRole("button", { name: "Approve exact action", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Proposal changed. Review the current proposal.");
  await expect(page.getByLabel(/^Decision note/)).toHaveValue("Preserve this note across the conflict");
  await expect(page.getByRole("button", { name: "Approve exact action", exact: true })).toBeDisabled();
  expect(brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_decisions WHERE approval_id=?").get(approvalId)).toEqual({ n: 0 });
});

test("work item expected-version conflict preserves the intended move and current state", async ({ page, governor }) => {
  const { brain, actor, ws } = await world(page, governor);
  const now = brain.store.now();
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-edge','Edge objective','Test conflict handling','[]',?,?,?)").run(actor.actorId, now, now);
  ws.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-edge','obj-edge',1,?,'confirmed','manual',?,'[]',?)").run(DIGEST, actor.actorId, now);
  ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-edge','obj-edge','plan-edge','step','Conflict-safe work','ready','[]','Move to In Progress',?,?)").run(now, now);
  await page.goto(`${governor.url}/w/ws-edge/plans?mission=obj-edge`);
  await page.getByRole("button", { name: "Manage Conflict-safe work", exact: true }).click();
  await page.getByLabel("Move Conflict-safe work", { exact: true }).click();
  await page.getByRole("option", { name: "In Progress", exact: true }).click();
  ws.prepare("UPDATE work_items SET version=2 WHERE id='work-edge'").run();
  await page.getByRole("button", { name: "Move work item", exact: true }).click();
  await expect(page.getByText("This work changed; your intended move is preserved", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Move Conflict-safe work", exact: true })).toContainText("In Progress");
  expect(ws.prepare("SELECT state FROM work_items WHERE id='work-edge'").get()).toEqual({ state: "ready" });
});

test("unknown run outcome exposes reconciliation and never a generic retry", async ({ page, governor }) => {
  const { brain, actor } = await world(page, governor);
  const bundle = fixtureStarter();
  const release = brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  brain.activateRelease(actor, release.digest);
  const now = brain.store.now();
  brain.store.control.prepare("INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms) VALUES ('job-edge',?,'ws-edge','edge-execution','run-edge','publish','outcome_unknown',?,'{}',?,'write',?,?,?)").run(actor.organizationId, release.digest, DIGEST, now, now, now + 3600_000);
  await page.goto(`${governor.url}/runs/job-edge`);
  await expect(page.getByText("Effect outcome is unknown", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reconcile outcome", exact: true }).click();
  await page.getByLabel(/^Reason/).fill("Inspect the target before any subsequent attempt");
  await page.getByRole("button", { name: "Record reconciliation request", exact: true }).click();
  await expect(page.getByText("Queued for execution.", { exact: true })).toBeVisible();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM reconciliation_requests WHERE job_id='job-edge'").get() as { state: string }).state).toBe("pending");
  expect(brain.store.control.prepare("SELECT state FROM jobs WHERE id='job-edge'").get()).toEqual({ state: "outcome_unknown" });
});

test("draining runner retains busy allocation evidence as a separate state axis", async ({ page, governor }) => {
  const { brain, actor } = await world(page, governor);
  const now = brain.store.now();
  brain.store.control.prepare("INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity,slots_reserved) VALUES ('runner-edge',?,'agents','key','draining','healthy',?,1,?,4000,8192,20480,2,1)").run(actor.organizationId, DIGEST, now);
  await page.goto(`${governor.url}/runners`);
  await expect(page.getByText("runner-edge", { exact: true })).toBeVisible();
  await expect(page.getByText("Draining", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByText("1/2", { exact: true })).toBeVisible();
  await expect(page.getByText("No new assignments; existing attempts continue with their leases.", { exact: true })).toBeVisible();
});

test("workspace revocation clears protected content instead of retaining its cached mission work", async ({ page, governor }) => {
  const { brain, actor, ws } = await world(page, governor);
  const now = brain.store.now();
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-private','Private objective','Protected','[]',?,?,?)").run(actor.actorId, now, now);
  ws.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-private','obj-private',1,?,'confirmed','manual',?,'[]',?)").run(DIGEST, actor.actorId, now);
  ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-private','obj-private','plan-private','step','Private customer investigation','ready','[]','Inspect',?,?)").run(now, now);
  await page.goto(`${governor.url}/w/ws-edge/plans?mission=obj-private`);
  await expect(page.getByText("Private customer investigation", { exact: true })).toBeVisible();
  brain.store.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE workspace_id='ws-edge' AND principal_id=?").run(brain.store.now(), actor.actorId);
  await page.goto(`${governor.url}/w/ws-edge/plans?mission=obj-private`);
  await expect(page.getByText("Private customer investigation", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
});
