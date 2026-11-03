/**
 * Throwaway seeded demo world for the UI polish run (recipe:
 * brain-ui-screenshot-world memory + tests/browser/fixtures.ts +
 * tests/browser/operational.spec.ts + tests/browser/ui-revamp.spec.ts).
 *
 * Run from the repo root:
 *   BRAIN_BASE_URL=http://127.0.0.1:3103 NODE_OPTIONS=--unhandled-rejections=warn \
 *     pnpm exec tsx tests/browser/ui-polish-world.mts
 *
 * The adaptor server listens on 3103 FIRST (a runner enroll fetches before
 * seeding finishes); BRAIN_BASE_URL must match the listener or Better Auth
 * rejects the SPA's origin and the rejection crashes the world. The script
 * prints `READY {…json…}` with every id the UI routes need, then keeps
 * serving until it is killed.
 */
import { createAdaptorServer } from "@hono/node-server";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/governor/src/http/app";
import { fixtureStarter } from "../support/starter";
import { captureOperation } from "../support/capitalization";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";

// fixtureStarter() reads examples/v1/starter-release relative to cwd.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), "../.."));

const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"b".repeat(64)}`;

function expectEqual(actual: unknown, awaited: unknown, what: string): void {
	if (actual !== awaited) throw new Error(`${what}: expected ${JSON.stringify(awaited)}, got ${JSON.stringify(actual)}`);
}

function sha256(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Content-addressed CAS write so a seeded artifact's digest matches its bytes. */
function seedCasBytes(brain: { casPath(digest: string): string }, bytes: Buffer): string {
	const digest = sha256(bytes);
	const path = brain.casPath(digest);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, bytes);
	return digest;
}

// Port first: runner enrollment and the SPA hit HTTP while seeding continues.
const dataDir = mkdtempSync(join(tmpdir(), "brain-polish-world-"));
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const server = createAdaptorServer({ fetch: (request) => (app ? app.fetch(request) : new Response("starting", { status: 503 })) });
await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(PORT, "127.0.0.1", () => {
		server.off("error", reject);
		resolve();
	});
});

app = await createApp({ dataDir });
const brain = app.brain;
const s = brain.store;
const credential = readFileSync(join(dataDir, "setup.token"), "utf8").trim();

const boot = await brain.bootstrap(
	{ organizationId: "org-polish", name: "Operations", email: "operator@shots.test", password: "shots-password-123" },
	credential,
);
const headers = new Headers({ authorization: `Bearer ${boot.sessionToken}` });
const identity = await brain.resolveActor(headers);
brain.createWorkspace(identity.actor, { workspaceId: "operations", slug: "operations" });
const actor = (await brain.resolveActor(headers, "operations")).actor;
for (const role of ["operator", "approver"]) {
	s.control
		.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES ('operations',?,?,?,1,?,?)")
		.run(actor.organizationId, actor.actorId, role, actor.actorId, s.now());
}

// Active release with the fixture-engine starter workflows.
const bundle = fixtureStarter();
const release = brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
brain.activateRelease(actor, release.digest);
// A Workflow draft so the Studio list and editor screens are populated.
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-configdraft-1", commandType: "configDraft.create", workspaceId: "operations", idempotencyKey: "polish-configdraft-1", payload: { title: "Visual polish workflow", kind: "Workflow" } }, "polish-world");
const capTool = (JSON.parse(brain.activeRelease(actor.organizationId)!.manifest) as { manifest: { tools: Array<{ id: string; digest: string }> } }).manifest.tools[0]!;
for (const root of ["polish-cap-1", "polish-cap-2", "polish-cap-3"]) captureOperation({ brain, org: actor.organizationId, workspaceId: "operations" }, root, capTool);
brain.runCapitalization();

// Enrolled fixture runners (real enrollment over HTTP against the listener).
const runnerCfg = (group: string) => ({
	governorUrl: BASE,
	runnerId: `runner-polish-${group}`,
	stateDir: join(brain.store.dataDir, `runner-${group}`),
	engines: ["fixture"],
	capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"],
});
const authorCfg = runnerCfg("agents");
const evaluatorCfg = runnerCfg("evaluators");
const authorSession = await enrollAndHello(authorCfg, brain.issueEnrollment(actor, "agents").token);
const evaluatorSession = await enrollAndHello(evaluatorCfg, brain.issueEnrollment(actor, "evaluators").token);

const dispatch = async (key: string, workflow: { id: string; digest: string }, input: Record<string, unknown>) => {
	const dispatched = brain.executeCommand(
		actor,
		{ contractVersion: "brain.command/v1", commandId: `polish-${key}`, commandType: "workflow.dispatch", workspaceId: "operations", idempotencyKey: `polish-${key}`, payload: { workflow, input } },
		"polish-world",
	);
	expectEqual(dispatched.receipt.accepted, true, `dispatch ${key}`);
	const job = s.control.prepare("SELECT id FROM jobs ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string };
	return job.id;
};

const workflowView = brain.executeQuery(actor, { queryType: "workflows.list", workspaceId: "operations" }) as unknown as {
	snapshot: { items: { release: { id: string; digest: string } }[] };
};
const triage = workflowView.snapshot.items.find((item) => item.release.id === "operations-triage")!.release;
const draft = workflowView.snapshot.items.find((item) => item.release.id === "support-draft")!.release;

// Succeeded run 1: triage with evidence.
const jobTriage = await dispatch("triage-1", triage, { situation: "Latency increased after the latest deployment" });
expectEqual(await runOnce(authorCfg, authorSession.sessionToken, authorSession.epoch), true, "author run for triage");
expectEqual(await runOnce(evaluatorCfg, evaluatorSession.sessionToken, evaluatorSession.epoch), true, "evaluator run for triage");
const attemptTriage = (s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? ORDER BY attempt_no DESC LIMIT 1").get(jobTriage) as { id: string }).id;
const runId = (s.workspaceDb("operations", actor.organizationId).prepare("SELECT id FROM workflow_runs ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string }).id;

// Succeeded run 2: support draft with evidence.
const jobDraft = await dispatch("draft-1", draft, { title: "Session expired mid-shift", body: "I cannot sign in after this morning's update" });
expectEqual(await runOnce(authorCfg, authorSession.sessionToken, authorSession.epoch), true, "author run for draft");
expectEqual(await runOnce(evaluatorCfg, evaluatorSession.sessionToken, evaluatorSession.epoch), true, "evaluator run for draft");

// A live (dispatched, never claimed) run with its console session.
const jobLive = await dispatch("live-1", triage, { situation: "Second region reports intermittent 502s on the new endpoint" });
const sessionLive = `ses-${jobLive}`;
const ws = s.workspaceDb("operations", actor.organizationId);
ws.prepare(
	"INSERT INTO sessions(id,job_id,attempt_id,mode,agent_id,task,engine_id,adapter_digest,engine_features,state,root_session_id,worktree_id,created_by,created_at_ms,updated_at_ms) VALUES (?,?,NULL,'native','',?, 'fixture',?,'[]','running',?,?, 'runner',?,?)",
).run(sessionLive, jobLive, `job ${jobLive}`, DIGEST, sessionLive, `read-only:operations`, s.now(), s.now());

// Objectives, plans and work items — one BLOCKED ("waiting on credentials").
const now = s.now();
ws.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-polish','Stabilize SSO authentication','Investigate the sign-in latency regression and land an independently verified correction','[\"Independent evidence passes\"]',?,?,?)").run(actor.actorId, now, now);
const tasks = [
	{ id: "inspect", title: "Inspect the current sign-in flow", criteria: ["Observations are attached"], dependsOn: [] },
	{ id: "fix", title: "Implement the reviewed change", criteria: ["Change matches the review"], dependsOn: ["inspect"] },
	{ id: "verify", title: "Verify the correction independently", criteria: ["Independent verdict passes"], dependsOn: ["fix"] },
	{ id: "document", title: "Update the operator runbook", criteria: ["Runbook covers the new check"], dependsOn: ["verify"] },
];
ws.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-polish','obj-polish',1,?,'confirmed','manual',?,?,?)").run(DIGEST, actor.actorId, JSON.stringify(tasks), now);
ws.prepare("INSERT INTO planning_requests(objective_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES ('obj-polish',?,'polish-plan','ready','plan-polish',?,?)").run(actor.actorId, now, now);
for (const [id, taskId, title, state, reason] of [
	["work-inspect", "inspect", "Inspect the current sign-in flow", "in-progress", null],
	["work-fix", "fix", "Implement the reviewed change", "blocked", "waiting on credentials"],
	["work-verify", "verify", "Verify the correction independently", "review", null],
	["work-runbook", "document", "Update the operator runbook", "ready", null],
] as const) {
	ws.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,blocked_reason,created_at_ms,updated_at_ms) VALUES (?,'obj-polish','plan-polish',?,?,?,'[\"Independent evidence passes\"]','Review acceptance and evidence',?,?,?)").run(id, taskId, title, state, reason, now, now);
}
ws.prepare("INSERT INTO execution_links(work_item_id,run_id,job_id,attempt_id,created_at_ms) VALUES ('work-inspect',?,?,?,?)").run(runId, jobTriage, attemptTriage, now);

// Board cards — the blocked one is the only blocked item in the world.
const card = (key: string) => {
	const row = s.control.prepare("SELECT receipt_json FROM command_idempotency WHERE organization_id=? AND idempotency_key=?").get(actor.organizationId, `polish-${key}`) as { receipt_json: string } | undefined;
	if (!row) throw new Error(`world seed could not resolve card ${key}`);
	return (JSON.parse(row.receipt_json) as { resourceId?: string }).resourceId ?? "";
};
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-card-a", commandType: "board.create", workspaceId: "operations", idempotencyKey: "polish-card-a", payload: { title: "Publish the SSO incident review", criteria: ["Evidence", "Reviewer sign-off"] } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-card-b", commandType: "board.create", workspaceId: "operations", idempotencyKey: "polish-card-b", payload: { title: "Implement the reviewed change", criteria: ["Change matches the review"] } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-card-c", commandType: "board.create", workspaceId: "operations", idempotencyKey: "polish-card-c", payload: { title: "Rotate the SSO signing key", criteria: ["Verification passes"] } }, "polish-world");
const cardA = card("card-a");
const cardB = card("card-b");
const cardC = card("card-c");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-move-b", commandType: "board.move", workspaceId: "operations", idempotencyKey: "polish-move-b", expectedVersion: 1, payload: { cardId: cardB, status: "blocked" } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-move-c", commandType: "board.move", workspaceId: "operations", idempotencyKey: "polish-move-c", expectedVersion: 1, payload: { cardId: cardC, status: "in-progress" } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-comment-a", commandType: "board.comment", workspaceId: "operations", idempotencyKey: "polish-comment-a", payload: { cardId: cardA, text: "Review packet is attached to the run; publication waits for the approval gate." } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-decision-a", commandType: "decision.record", workspaceId: "operations", idempotencyKey: "polish-decision-a", expectedVersion: 1, payload: { cardId: cardA, decision: "go", note: "Proceed once the independent verdict is accepted" } }, "polish-world");

// Tickets + SLA intervals.
ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority,created_at_ms) VALUES ('ticket-polish-1','support','1041','open','Customer cannot sign in with SSO',?,'v1',?, 'urgent',?)").run(DIGEST, now - 30 * 60_000, now - 40 * 60_000);
ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority,created_at_ms) VALUES ('ticket-polish-2','support','1042','in-progress','Password reset emails arrive late',?,'v1',?, 'high',?)").run(DIGEST, now - 3 * 3600_000, now - 4 * 3600_000);
ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority,created_at_ms) VALUES ('ticket-polish-3','support','1043','open','Dashboard charts render blank for one tenant',?,'v1',?, 'normal',?)").run(DIGEST, now - 26 * 3600_000, now - 27 * 3600_000);
const calendar = sha256(Buffer.from("sla-calendar-polish"));
for (const [id, ticket, event, responsibility, start, end] of [
	["sla-polish-1", "ticket-polish-1", "evt-sla-1", "keyrus", now - 30 * 60_000, null],
	["sla-polish-2", "ticket-polish-1", "evt-sla-2", "client", now - 20 * 60_000, now - 12 * 60_000],
	["sla-polish-3", "ticket-polish-2", "evt-sla-3", "hub", now - 3 * 3600_000, now - 2 * 3600_000],
	["sla-polish-4", "ticket-polish-3", "evt-sla-4", "keyrus", now - 26 * 3600_000, now - 25 * 3600_000],
] as const) {
	ws.prepare("INSERT INTO sla_intervals(id,ticket_id,event_id,responsibility,started_at_ms,ended_at_ms,calendar_digest) VALUES (?,?,?,?,?,?,?)").run(id, ticket, event, responsibility, start, end, calendar);
}

// Incidents + observations.
ws.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms) VALUES ('incident-polish-1','sso-production','critical','SSO sign-in latency regression','investigating',2,?)").run(now - 30 * 60_000);
ws.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms,resolved_at_ms) VALUES ('incident-polish-2','model-gateway','high','Elevated 502s from the model gateway','mitigated',3,?,?)").run(now - 5 * 3600_000, now - 2 * 3600_000);
ws.prepare("INSERT INTO observations(id,connector_id,target_key,incident_id,observation_digest,source_event_id,observed_at_ms,expires_at_ms) VALUES ('observation-polish-1','monitoring','sso-production','incident-polish-1',?,'polish-observation-1',?,?)").run(DIGEST, now - 25 * 60_000, now + 3600_000);
ws.prepare("INSERT INTO observations(id,connector_id,target_key,incident_id,observation_digest,source_event_id,observed_at_ms,expires_at_ms) VALUES ('observation-polish-2','monitoring','model-gateway','incident-polish-2',?,'polish-observation-2',?,?)").run(DIGEST, now - 4 * 3600_000, now + 3600_000);

// Delivery dossier with rubric results.
ws.prepare("INSERT INTO delivery_dossiers(id,source_revision,manifest_digest,rubric_digest,state,version,created_at_ms) VALUES ('dossier-polish','rev-polish-1',?,?, 'evaluating',1,?)").run(DIGEST, DIGEST, now);
for (const [criterion, outcome] of [["coverage", "passed"], ["independent-verification", "passed"], ["rollback-plan", "incomplete"]] as const) {
	ws.prepare("INSERT INTO rubric_results(dossier_id,criterion_id,evaluator_attempt_id,outcome,evidence_digest) VALUES (?,?,?,?,?)").run("dossier-polish", criterion, attemptTriage, outcome, DIGEST);
}

// Knowledge: scoped memory facts (secret-free by store policy).
brain.memory.publish({ organizationId: actor.organizationId, workspaceId: "operations", sourceId: "runbook-sso-latency", text: "SSO latency runbook: check the issuer metadata, callback URL and session freshness before touching the identity provider. The current regression window matches deploy rev-polish-1." });
brain.memory.publish({ organizationId: actor.organizationId, workspaceId: "operations", sourceId: "escalation-path", text: "Escalation: identity provider incidents page the on-call operations engineer; hub wait time is billed to the client after 30 minutes." });
brain.memory.publish({ organizationId: actor.organizationId, workspaceId: "operations", sourceId: "gateway-note", text: "Model gateway 502 clusters historically follow certificate rotation; verify the gateway certificate chain first." });

// Schedules: one cron sweep and one manual follow-up.
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-auto-1", commandType: "automation.upsert", workspaceId: "operations", idempotencyKey: "polish-auto-1", payload: { title: "Daily triage sweep", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, execution: { mode: "managed" }, input: { situation: "Scheduled daily triage sweep" } } }, "polish-world");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-auto-2", commandType: "automation.upsert", workspaceId: "operations", idempotencyKey: "polish-auto-2", payload: { title: "Verification follow-up", target: { kind: "workItem", id: "work-verify" }, trigger: { kind: "manual" }, execution: { mode: "managed" } } }, "polish-world");

// Documents/resources with real extracted text.
const document = (key: string, title: string, fileName: string, body: string) => {
	const uploaded = brain.executeCommand(
		actor,
		{ contractVersion: "brain.command/v1", commandId: `polish-doc-${key}`, commandType: "document.upload", workspaceId: "operations", idempotencyKey: `polish-doc-${key}`, payload: { title, fileName, mediaType: "text/markdown", bytesBase64: Buffer.from(body).toString("base64") } },
		"polish-world",
	);
	return uploaded.receipt.resourceId!;
};
const doc1 = document("review", "SSO incident review", "sso-incident-review.md", "# SSO incident review\n\nTimeline, affected tenants and the verified correction for the sign-in latency regression.\n\n## Verification\n\nThe verifier reproduced the success criterion independently before publication.");
const doc2 = document("runbook", "Operator runbook", "operator-runbook.md", "# Operator runbook\n\nCheck issuer, callback URL and session freshness first. Escalate to the identity provider on-call after 30 minutes of client wait.");
brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "polish-assoc-1", commandType: "document.associate", workspaceId: "operations", idempotencyKey: "polish-assoc-1", payload: { documentId: doc1, resource: { kind: "workItem", id: "work-inspect" } } }, "polish-world");

// Outputs/artifacts attached to the succeeded run (CAS-backed, two versions).
const artifactV1 = Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.");
const artifactV2 = Buffer.from("# SSO guide\nCheck issuer, callback URL, session freshness and independent evidence.\n\n## Verified correction\nRotating the signing key resolved the regression; the verifier reproduced the success criterion independently.");
const digestV1 = seedCasBytes(brain, artifactV1);
const digestV2 = seedCasBytes(brain, artifactV2);
ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES ('artifact-polish',?,?,'text/markdown','internal','verified',?)").run(digestV1, artifactV1.length, now);
ws.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES ('artifact-polish-v2',?,?,'text/markdown','internal','verified',?)").run(digestV2, artifactV2.length, now + 1);
for (const [artifactId, digest] of [["artifact-polish", digestV1], ["artifact-polish-v2", digestV2]] as const) {
	s.control.prepare("INSERT INTO artifact_associations(artifact_id,organization_id,workspace_id,digest,owner_kind,owner_id,classification,verified_at_ms) VALUES (?,?, 'operations',?, 'job',?, 'internal',?)").run(artifactId, actor.organizationId, digest, jobTriage, now);
}
ws.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?, 'bundle-polish', ?, ?, 'verified', ?, ?)").run(BUNDLE_DIGEST, jobTriage, attemptTriage, JSON.stringify({ checks: [{ criterionId: "Evidence", status: "passed" }, { criterionId: "Verification passes", status: "passed" }], artifacts: [{ digest: digestV1 }, { digest: digestV2 }] }), now);
ws.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms,finalized_at_ms) VALUES ('verdict-polish',?,?,?,'verified',?,?,?)").run(BUNDLE_DIGEST, attemptTriage, DIGEST, JSON.stringify({ checks: [{ criterionId: "Evidence", status: "passed" }, { criterionId: "Verification passes", status: "passed" }] }), now, now);

// Console log stream: a few session events for the live session.
s.emit(s.control, { organizationId: actor.organizationId, workspaceId: "operations", aggregateType: "session", aggregateId: sessionLive, eventType: "session.message", payload: { text: "Inspecting the second-region 502 reports and the current observations" } });
s.emit(s.control, { organizationId: actor.organizationId, workspaceId: "operations", aggregateType: "session", aggregateId: sessionLive, eventType: "tool.proposed", payload: { proposalId: "polish-tool-1", tool: { id: "operations.context", digest: DIGEST }, input: { target: "sso-production" } } });
s.emit(s.control, { organizationId: actor.organizationId, workspaceId: "operations", aggregateType: "session", aggregateId: sessionLive, eventType: "session.message", payload: { text: "Correlation found: both regions rolled out the same endpoint revision" } });

// Pending approval bound to the active release.
brain.ensurePrincipal(actor.organizationId, "polish-requester", "human");
const subject = {
	organizationId: actor.organizationId,
	workspaceId: "operations",
	operation: "support.reply.publish",
	tool: { id: "support.publish", digest: DIGEST },
	inputDigest: DIGEST,
	target: { targetId: "ticket-polish-1", environmentId: "production", preconditionDigest: DIGEST },
	artifactDigest: DIGEST,
	policyDigest: DIGEST,
	configDigest: release.digest,
	effectBounds: { ticketId: "ticket-polish-1", publication: "Exact reviewed response only" },
	expiresAt: new Date(now + 2 * 3600_000).toISOString(),
	nonce: "polish-approval",
};
const approvalId = brain.createApprovalForGate({ organizationId: actor.organizationId, workspaceId: "operations", runId, stepId: "publish", subject, expiresAtMs: now + 2 * 3600_000, requestedBy: "polish-requester" });

// Resolve every id through the API before declaring READY — nothing printed
// here may be a guess.
const resolveId = (label: string, query: { sql: string; db: "control" | "workspace"; args?: unknown[] }) => {
	const db = query.db === "control" ? s.control : ws;
	const row = db.prepare(query.sql).get(...(query.args ?? [])) as Record<string, unknown> | undefined;
	const value = row ? Object.values(row)[0] : undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`world seed could not resolve ${label}`);
	return value;
};
const ids = {
	organization: boot.organizationId,
	workspace: "operations",
	release: release.digest,
	job: resolveId("job", { sql: "SELECT id FROM jobs WHERE id=?", db: "control", args: [jobTriage] }),
	jobDraft: resolveId("jobDraft", { sql: "SELECT id FROM jobs WHERE id=?", db: "control", args: [jobDraft] }),
	jobLive: resolveId("jobLive", { sql: "SELECT id FROM jobs WHERE id=?", db: "control", args: [jobLive] }),
	session: resolveId("session", { sql: "SELECT id FROM sessions WHERE id=?", db: "workspace", args: [sessionLive] }),
	approval: resolveId("approval", { sql: "SELECT id FROM approval_requests WHERE id=?", db: "control", args: [approvalId] }),
	runner: "runner-polish-agents",
	runnerEvaluators: "runner-polish-evaluators",
	ticket: resolveId("ticket", { sql: "SELECT id FROM tickets WHERE id=?", db: "workspace", args: ["ticket-polish-1"] }),
	incident: resolveId("incident", { sql: "SELECT id FROM incidents WHERE id=?", db: "workspace", args: ["incident-polish-1"] }),
	artifact: resolveId("artifact", { sql: "SELECT id FROM artifacts WHERE id=?", db: "workspace", args: ["artifact-polish"] }),
	document: resolveId("document", { sql: "SELECT id FROM documents WHERE id=?", db: "workspace", args: [doc1] }),
	card: resolveId("card", { sql: "SELECT id FROM cards WHERE id=?", db: "workspace", args: [cardA] }),
	cardBlocked: resolveId("cardBlocked", { sql: "SELECT id FROM cards WHERE id=?", db: "workspace", args: [cardB] }),
	plan: resolveId("plan", { sql: "SELECT id FROM plan_versions WHERE id=?", db: "workspace", args: ["plan-polish"] }),
	objective: resolveId("objective", { sql: "SELECT id FROM objectives WHERE id=?", db: "workspace", args: ["obj-polish"] }),
	dossier: resolveId("dossier", { sql: "SELECT id FROM delivery_dossiers WHERE id=?", db: "workspace", args: ["dossier-polish"] }),
	run: resolveId("run", { sql: "SELECT id FROM workflow_runs WHERE id=?", db: "workspace", args: [runId] }),
	attempt: resolveId("attempt", { sql: "SELECT id FROM job_attempts WHERE id=?", db: "control", args: [attemptTriage] }),
	evidenceBundle: BUNDLE_DIGEST,
};

console.log(`READY ${JSON.stringify(ids)}`);
console.log(`Brain polish world serving ${BASE} (data ${dataDir}); kill with $(cat /tmp/brain-polish-world.pid)`);
