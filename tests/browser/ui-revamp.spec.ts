import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";

const DIGEST = `sha256:${"a".repeat(64)}`;

interface ScreenTarget {
  id: string;
  route: string;
  heading: string | RegExp;
}

function targets(jobId: string, approvalId: string): ScreenTarget[] {
  return [
    { id: "01-today", route: "/today", heading: "Today" },
    { id: "02-bridge", route: "/bridge", heading: "Bridge" },
    { id: "03-workspace-overview", route: "/w/operations/overview", heading: "Operations" },
    { id: "04-board", route: "/w/operations/board", heading: "Work board" },
    { id: "05-plans", route: "/w/operations/plans?objective=obj-visual", heading: "Plans" },
    { id: "06-schedules", route: "/w/operations/schedules", heading: "Schedules" },
    { id: "07-resources", route: "/w/operations/resources", heading: "Resources" },
    { id: "08-start-work", route: "/w/operations/workflows?mode=catalog", heading: "Start work" },
    { id: "09-activity", route: "/w/operations/runs", heading: "Activity" },
    { id: "10-run-detail", route: `/jobs/${jobId}`, heading: "Run detail" },
    { id: "11-agents", route: "/w/operations/agents", heading: "Agents" },
    { id: "12-support", route: "/w/operations/support", heading: "Support" },
    { id: "13-ticket-detail", route: "/tickets/ticket-visual", heading: "Ticket casework" },
    { id: "14-incidents", route: "/w/operations/sre", heading: "Incidents" },
    { id: "15-incident-detail", route: "/incidents/incident-visual", heading: "Incident investigation" },
    { id: "16-delivery", route: "/w/operations/delivery", heading: "Delivery" },
    { id: "17-knowledge", route: "/w/operations/knowledge", heading: "Knowledge" },
    { id: "18-tools", route: "/tools", heading: "Trusted capability registry" },
    { id: "19-runners", route: "/runners", heading: "Execution fleet" },
    { id: "20-runner-detail", route: "/runners/runner-visual", heading: "Runner detail" },
    { id: "21-approvals", route: "/approvals", heading: "Approvals" },
    { id: "22-approval-detail", route: `/approvals/${approvalId}`, heading: "Approval review" },
    { id: "23-decisions", route: "/w/operations/decisions", heading: "Decisions" },
    { id: "24-settings-setup", route: "/settings?tab=setup", heading: "Workspace setup" },
    { id: "25-settings-security", route: "/settings?tab=security", heading: "Security center" },
    { id: "26-settings-integrations", route: "/administration/integrations", heading: "Integrations" },
    { id: "27-settings-release", route: "/settings?tab=release", heading: "Release management" },
    { id: "28-settings-members", route: "/settings?tab=members", heading: "Workspace access" },
    { id: "29-settings-invitations", route: "/settings?tab=invitations", heading: "Invitations" },
    { id: "30-settings-policy", route: "/settings?tab=policy", heading: "Authentication policy" },
    { id: "31-session-detail", route: "/sessions/session-visual", heading: "Live session" },
    { id: "32-settings-health", route: "/settings?tab=health", heading: "Platform operations" },
    { id: "33-tv-support", route: "/tv/support", heading: /Support/ },
    { id: "34-tv-sre", route: "/tv/sre", heading: /SRE/ },
  ];
}

test("all 34 revamped screens have browser screenshots and page-level containment", async ({ page, governor }, info) => {
  test.setTimeout(300_000);
  const brain = governor.app.brain;
  const response = await page.request.post(`${governor.url}/v1/setup`, { headers: { authorization: `Setup ${governor.credential}` }, data: { email: "visual@example.test", password: "visual-password-123", name: "Visual Operator", organizationId: "org-visual" } });
  expect(response.status()).toBe(201);
  const boot = await response.json();
  const headers = new Headers({ authorization: `Bearer ${boot.sessionToken}` });
  const identity = await brain.resolveActor(headers);
  brain.createWorkspace(identity.actor, { workspaceId: "operations", slug: "Operations" });
  const actor = (await brain.resolveActor(headers, "operations")).actor;
  const bundle = fixtureStarter();
  const release = brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  brain.activateRelease(actor, release.digest);
  for (const role of ["operator", "approver"]) brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES ('operations',?,?,?,1,?,?)").run(actor.organizationId, actor.actorId, role, actor.actorId, brain.store.now());

  const now = brain.store.now();
  const ws = brain.store.workspaceDb("operations", actor.organizationId);
  ws.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-visual','Stabilize authentication','Investigate and verify the sign-in flow','[\"Independent evidence passes\"]',?,?,?)").run(actor.actorId, now, now);
  const tasks = [{ id: "inspect", title: "Inspect the current sign-in flow", criteria: ["Observations are attached"], dependsOn: [] }, { id: "verify", title: "Verify the correction independently", criteria: ["Independent verdict passes"], dependsOn: ["inspect"] }];
  ws.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-visual','obj-visual',1,?,'proposed','manual',?,?,?)").run(DIGEST, actor.actorId, JSON.stringify(tasks), now);
  ws.prepare("INSERT INTO planning_requests(objective_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES ('obj-visual',?,'visual-plan','ready','plan-visual',?,?)").run(actor.actorId, now, now);
  for (const [id, title, state] of [["work-inspect", "Inspect the current sign-in flow", "in-progress"], ["work-verify", "Verify the correction independently", "review"], ["work-blocked", "Resolve stale session observations", "blocked"]] as const) ws.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,blocked_reason,created_at_ms,updated_at_ms) VALUES (?,'obj-visual','plan-visual',?,?,?,'[\"Independent evidence passes\"]','Review acceptance and evidence',?,?,?)").run(id, id, title, state, state === "blocked" ? "Current evidence is stale" : null, now, now);
  brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "visual-card", commandType: "board.create", workspaceId: "operations", idempotencyKey: "visual-card", payload: { title: "Authentication release", criteria: ["Evidence"] } }, "visual-correlation");
  const card = ws.prepare("SELECT id FROM cards LIMIT 1").get() as { id: string };
  brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "visual-decision", commandType: "decision.record", workspaceId: "operations", idempotencyKey: "visual-decision", expectedVersion: 1, payload: { cardId: card.id, decision: "go", note: "Proceed after independent evidence is accepted" } }, "visual-correlation");

  brain.ensurePrincipal(actor.organizationId, "visual-requester", "human");
  const subject = { organizationId: actor.organizationId, workspaceId: "operations", operation: "support.reply.publish", tool: { id: "support.publish", digest: DIGEST }, inputDigest: DIGEST, target: { targetId: "ticket-visual", environmentId: "production", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: release.digest, effectBounds: { ticketId: "ticket-visual", publication: "Exact reviewed response only" }, expiresAt: new Date(now + 3600_000).toISOString(), nonce: "visual-approval" };
  const approvalId = brain.createApprovalForGate({ organizationId: actor.organizationId, workspaceId: "operations", runId: "visual-run", stepId: "publish", subject, expiresAtMs: now + 3600_000, requestedBy: "visual-requester" });

  const workflowView = brain.executeQuery(actor, { queryType: "workflows.list", workspaceId: "operations" }) as unknown as { snapshot: { items: { release: { id: string; digest: string } }[] } };
  const workflow = workflowView.snapshot.items.find((item) => item.release.id === "operations-triage");
  expect(workflow).toBeTruthy();
  const dispatched = brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "visual-dispatch", commandType: "workflow.dispatch", workspaceId: "operations", idempotencyKey: "visual-dispatch", payload: { workflow: workflow!.release, input: { situation: "Sign-in latency increased after deployment" } } }, "visual-correlation");
  expect(dispatched.receipt.accepted).toBe(true);
  const job = brain.store.control.prepare("SELECT id FROM jobs ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string };

  brain.store.control.prepare("INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity) VALUES ('runner-visual',?,'agents','key','draining','healthy',?,1,?,4000,8192,20480,4)").run(actor.organizationId, DIGEST, now);
  for (const capability of ["os:linux", "engine:fixture", "tool:bash"]) brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES ('runner-visual',?,1,'fixture',?,?)").run(capability, now, now + 3600_000);

  ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority) VALUES ('ticket-visual','support','42','open','Customer cannot sign in with SSO',?,'v1',?,'urgent')").run(DIGEST, now);
  ws.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms) VALUES ('incident-visual','sso-production','critical','SSO sign-in latency regression','investigating',2,?)").run(now - 600_000);
  ws.prepare("INSERT INTO observations(id,connector_id,target_key,incident_id,observation_digest,source_event_id,observed_at_ms,expires_at_ms) VALUES ('observation-visual','monitoring','sso-production','incident-visual',?,'visual-observation',?,?)").run(DIGEST, now, now + 3600_000);
  ws.prepare("INSERT INTO delivery_dossiers(id,source_revision,manifest_digest,rubric_digest,state,version,created_at_ms) VALUES ('delivery-visual',?,?,?,'evaluating',1,?)").run(DIGEST, DIGEST, DIGEST, now);
  ws.prepare("INSERT INTO sessions(id,job_id,attempt_id,engine_id,adapter_digest,state,event_sequence,updated_at_ms) VALUES ('session-visual',?,'attempt-visual','fixture',?,'running',0,?)").run(job.id, DIGEST, now);
  const insertEvent = brain.store.control.prepare("INSERT INTO events(event_id,organization_id,workspace_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insertEvent.run("visual-event-1", actor.organizationId, "operations", "session", "visual-model-1", 1, "session.message", JSON.stringify({ text: "Inspecting the sign-in flow and current observations" }), DIGEST, now);
  insertEvent.run("visual-event-2", actor.organizationId, "operations", "session", "visual-tool-1", 2, "tool.proposed", JSON.stringify({ proposalId: "visual-tool-1", tool: { id: "operations.context", digest: DIGEST }, input: { target: "sso-production" } }), DIGEST, now + 1);

  await page.goto(`${governor.url}/w/operations/resources`);
  await page.getByLabel("Document title", { exact: true }).fill("SSO investigation guide");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "sso-guide.md", mimeType: "text/markdown", buffer: Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.") });
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  await expect(page.locator("pre")).toContainText("SSO guide");

  const outputDir = join(process.cwd(), "artifacts", "ui-revamp", "screenshots", info.project.name);
  mkdirSync(outputDir, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const target of targets(job.id, approvalId)) {
    await page.goto(`${governor.url}${target.route}`);
    await expect(page.getByRole("heading", { name: target.heading, level: 1 }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(150);
    const containment = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(containment.document, `${target.id} page-level horizontal containment`).toBeLessThanOrEqual(containment.viewport + 1);
    await page.screenshot({ path: join(outputDir, `${target.id}.png`), fullPage: true });
    if (target.id.startsWith("33-") || target.id.startsWith("34-")) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.screenshot({ path: join(outputDir, `${target.id}-1920.png`), fullPage: true });
      await page.setViewportSize({ width: info.project.use.viewport?.width ?? 1440, height: 900 });
    }
  }
  expect(errors).toEqual([]);
});
