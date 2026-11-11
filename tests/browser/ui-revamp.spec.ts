import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"b".repeat(64)}`;

/** Content-addressed CAS write so a seeded artifact's digest matches its bytes. */
function seedCasBytes(brain: { store: Parameters<typeof casFilePath>[0] }, bytes: Buffer): string {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const path = casFilePath(brain.store, digest);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return digest;
}

interface ScreenTarget {
  id: string;
  route: string;
  heading: string | RegExp;
  /** Execution-console screens render app chrome, not a document h1. */
  testid?: string;
}

function targets(jobId: string, approvalId: string): ScreenTarget[] {
  return [
    { id: "01-missions", route: "/w/operations/missions", heading: "Missions" },
    { id: "02-workspaces", route: "/administration/workspaces", heading: "Workspaces" },
    { id: "03-mission", route: "/missions/obj-visual/live", heading: "Stabilize authentication" },
    { id: "05-mission-plan", route: "/missions/obj-visual/plan", heading: "Stabilize authentication" },
    { id: "06-task", route: "/plays/operations-triage", heading: "Investigate an operational issue" },
    { id: "07-resources", route: "/w/operations/knowledge?tab=documents", heading: "Resources" },
    { id: "08-plays", route: "/w/operations/plays?mode=catalog", heading: "Plays" },
    { id: "10-run-inspector", route: `/runs/${jobId}`, heading: "Run inspector" },
    { id: "10b-live", route: "/w/operations/live", heading: "Sessions & runs", testid: "console-rail" },
    { id: "10c-logs", route: "/w/operations/logs", heading: "Logs" },
    { id: "10d-outputs", route: "/w/operations/outputs", heading: "Outputs" },
    { id: "10e-artifact", route: "/outputs/artifact-visual", heading: "Artifact" },
    { id: "10f-output-preview", route: "/w/operations/outputs?artifact=artifact-visual-v2&view=list", heading: "Outputs" },
    { id: "10g-mission-outputs", route: "/missions/obj-visual/outputs", heading: "Stabilize authentication" },
    { id: "11-agents", route: "/studio/Agent", heading: "Agent Studio" },
    { id: "12-support", route: "/w/operations/plays/support", heading: "Support" },
    { id: "13-ticket-detail", route: "/tickets/ticket-visual", heading: "Ticket casework" },
    { id: "14-incidents", route: "/w/operations/plays/sre", heading: "Incidents" },
    { id: "15-incident-detail", route: "/incidents/incident-visual", heading: "Incident investigation" },
    { id: "17-knowledge", route: "/w/operations/knowledge", heading: "Knowledge" },
    { id: "18-tools", route: "/w/operations/knowledge?tab=tools", heading: "Trusted capability registry" },
    { id: "19-runners", route: "/runners", heading: "Runners" },
    { id: "20-runner-detail", route: "/runners/runner-visual", heading: "Runner detail" },
    { id: "21-approvals", route: "/approvals", heading: "Approvals" },
    { id: "22-approval-detail", route: `/approvals/${approvalId}`, heading: "Approval review" },
    { id: "24-settings-setup", route: "/settings?tab=setup", heading: "Setup" },
    { id: "25-settings-security", route: "/settings?tab=security", heading: "Security" },
    { id: "26-settings-integrations", route: "/administration/integrations", heading: "Integrations" },
    { id: "27-settings-release", route: "/settings?tab=release", heading: "Releases" },
    { id: "28-settings-members", route: "/settings?tab=members", heading: "Workspace access" },
    { id: "29-settings-invitations", route: "/settings?tab=invitations", heading: "Invitations" },
    { id: "30-settings-policy", route: "/settings?tab=policy", heading: "Authentication" },
    { id: "31-session-detail", route: "/sessions/session-visual", heading: "Sessions & runs", testid: "console-rail" },
    { id: "32-settings-health", route: "/settings?tab=health", heading: "Health" },
    { id: "33-tv-support", route: "/tv/support", heading: /Support/ },
    { id: "34-tv-sre", route: "/tv/sre", heading: /SRE/ },
  ];
}

test("all 38 revamped screens have browser screenshots and page-level containment", async ({ page, governor }, info) => {
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
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-visual','Stabilize authentication','Investigate and verify the sign-in flow','[\"Independent evidence passes\"]',?,?,?)").run(actor.actorId, now, now);
  const tasks = [{ id: "inspect", title: "Inspect the current sign-in flow", criteria: ["Observations are attached"], dependsOn: [] }, { id: "verify", title: "Verify the correction independently", criteria: ["Independent verdict passes"], dependsOn: ["inspect"] }];
  ws.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-visual','obj-visual',1,?,'proposed','manual',?,?,?)").run(DIGEST, actor.actorId, JSON.stringify(tasks), now);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES ('obj-visual',?,'visual-plan','ready','plan-visual',?,?)").run(actor.actorId, now, now);
  for (const [id, title, state] of [["work-inspect", "Inspect the current sign-in flow", "in-progress"], ["work-verify", "Verify the correction independently", "review"], ["work-blocked", "Resolve stale session observations", "blocked"]] as const) ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,blocked_reason,created_at_ms,updated_at_ms) VALUES (?,'obj-visual','plan-visual',?,?,?,'[\"Independent evidence passes\"]','Review acceptance and evidence',?,?,?)").run(id, id, title, state, state === "blocked" ? "Current evidence is stale" : null, now, now);
  ws.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-release','obj-visual','plan-visual','release','Authentication release','review','[\"Evidence\"]','Review acceptance and evidence',?,?)").run(now, now);

  brain.ensurePrincipal(actor.organizationId, "visual-requester", "human");
  const subject = { organizationId: actor.organizationId, workspaceId: "operations", operation: "support.reply.publish", tool: { id: "support.publish", digest: DIGEST }, inputDigest: DIGEST, target: { targetId: "ticket-visual", environmentId: "production", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: release.digest, effectBounds: { ticketId: "ticket-visual", publication: "Exact reviewed response only" }, expiresAt: new Date(now + 3600_000).toISOString(), nonce: "visual-approval" };
  const approvalId = brain.createApprovalForGate({ organizationId: actor.organizationId, workspaceId: "operations", runId: "visual-run", stepId: "publish", subject, expiresAtMs: now + 3600_000, requestedBy: "visual-requester" });

  const workflowView = (await brain.executeQuery(actor, { queryType: "workflows.list", workspaceId: "operations" })) as unknown as { snapshot: { items: { release: { id: string; digest: string } }[] } };
  const workflow = workflowView.snapshot.items.find((item) => item.release.id === "operations-triage");
  expect(workflow).toBeTruthy();
  const dispatched = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "visual-dispatch", commandType: "workflow.dispatch", workspaceId: "operations", idempotencyKey: "visual-dispatch", payload: { workflow: workflow!.release, input: { situation: "Sign-in latency increased after deployment" } } }, "visual-correlation");
  expect(dispatched.receipt.accepted).toBe(true);
  const job = brain.store.control.prepare("SELECT id FROM jobs ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string };

  brain.store.control.prepare("INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity) VALUES ('runner-visual',?,'agents','key','draining','healthy',?,1,?,4000,8192,20480,4)").run(actor.organizationId, DIGEST, now);
  for (const capability of ["os:linux", "engine:fixture", "tool:bash"]) brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES ('runner-visual',?,1,'fixture',?,?)").run(capability, now, now + 3600_000);

  ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority) VALUES ('ticket-visual','support','42','open','Customer cannot sign in with SSO',?,'v1',?,'urgent')").run(DIGEST, now);
  ws.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms) VALUES ('incident-visual','sso-production','critical','SSO sign-in latency regression','investigating',2,?)").run(now - 600_000);
  ws.prepare("INSERT INTO observations(id,connector_id,target_key,incident_id,observation_digest,source_event_id,observed_at_ms,expires_at_ms) VALUES ('observation-visual','monitoring','sso-production','incident-visual',?,'visual-observation',?,?)").run(DIGEST, now, now + 3600_000);
  ws.prepare("INSERT INTO sessions(id,job_id,attempt_id,engine_id,adapter_digest,state,event_sequence,updated_at_ms) VALUES ('session-visual',?,'attempt-visual','fixture',?,'running',0,?)").run(job.id, DIGEST, now);
  // Authorized final artifacts so the Output Browser deep link has real data:
  // two comparable versions of one output with CAS-backed bytes, an accepted
  // verification verdict and a work-item execution link.
  const artifactV1 = Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.");
  const artifactV2 = Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.\n\n## Verified correction\nRotating the signing key resolved the regression; the verifier reproduced the success criterion independently.");
  const digestV1 = seedCasBytes(brain, artifactV1);
  const digestV2 = seedCasBytes(brain, artifactV2);
  const insertArtifact = ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES (?,?,?,?,?,'verified',?)");
  insertArtifact.run("artifact-visual", digestV1, artifactV1.length, "text/markdown", "internal", now);
  insertArtifact.run("artifact-visual-v2", digestV2, artifactV2.length, "text/markdown", "internal", now + 1);
  const insertAssociation = brain.store.control.prepare("INSERT INTO artifact_associations(artifact_id,organization_id,workspace_id,digest,owner_kind,owner_id,classification,verified_at_ms) VALUES (?,?,?,?, 'job',?, 'internal', ?)");
  insertAssociation.run("artifact-visual", actor.organizationId, "operations", digestV1, job.id, now);
  insertAssociation.run("artifact-visual-v2", actor.organizationId, "operations", digestV2, job.id, now);
  ws.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?, 'verified', ?, ?)").run(BUNDLE_DIGEST, "bundle-visual", job.id, "attempt-visual", JSON.stringify({ artifacts: [{ digest: digestV1 }, { digest: digestV2 }] }), now);
  ws.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES (?,?,?,?, 'verified', ?, ?)").run("verdict-visual", BUNDLE_DIGEST, "attempt-visual", DIGEST, JSON.stringify({ checks: [] }), now);
  ws.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,job_id,attempt_id,created_at_ms) VALUES ('obj-visual','work-inspect','visual-run',?,'attempt-visual',?)").run(job.id, now);
  const insertEvent = brain.store.control.prepare("INSERT INTO events(event_id,organization_id,workspace_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insertEvent.run("visual-event-1", actor.organizationId, "operations", "session", "visual-model-1", 1, "session.message", JSON.stringify({ text: "Inspecting the sign-in flow and current observations" }), DIGEST, now);
  insertEvent.run("visual-event-2", actor.organizationId, "operations", "session", "visual-tool-1", 2, "tool.proposed", JSON.stringify({ proposalId: "visual-tool-1", tool: { id: "operations.context", digest: DIGEST }, input: { target: "sso-production" } }), DIGEST, now + 1);

  await page.goto(`${governor.url}/w/operations/knowledge?tab=documents`);
  await page.getByRole("button", { name: "Add document", exact: true }).click();
  await page.getByLabel(/^Document title/).fill("SSO investigation guide");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "sso-guide.md", mimeType: "text/markdown", buffer: Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.") });
  await page.getByRole("dialog").getByRole("button", { name: "Upload document", exact: true }).click();
  await expect(page.locator("pre")).toContainText("SSO guide");

  const outputDir = join(process.cwd(), "artifacts", "ui-revamp", "screenshots", info.project.name);
  mkdirSync(outputDir, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const target of targets(job.id, approvalId)) {
    await page.goto(`${governor.url}${target.route}`);
    const landmark = target.testid
      ? page.getByTestId(target.testid).getByRole("heading", { name: target.heading })
      : page.getByRole("heading", { name: target.heading, level: 1 });
    await expect(landmark.first()).toBeVisible({ timeout: 20_000 });
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
