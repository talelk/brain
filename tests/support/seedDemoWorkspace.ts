import { createHash } from "node:crypto";
import type { ActorContext, WorkItem, WorkItemState } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";

const DIGEST = `sha256:${"a".repeat(64)}`;

export interface DemoSeed {
  /** One mission per interesting state: the busy active one, a paused one and a cancelled one. */
  missionIds: { active: string; paused: string; closed: string };
  /** The confirmed plan version of the active mission. */
  planVersionId: string;
  /** Work item id by state (all seven states are present on the active mission). */
  workItems: Record<WorkItemState, string>;
  approvalId: string;
  ticketId: string;
  incidentId: string;
  runnerId: string;
  documentId: string;
  /** Present when a workflow dispatch was requested: the run, its job and the session seeded on it. */
  run?: { runId: string; jobId: string; sessionId: string };
}

export interface DemoSeedOptions {
  /** Dispatch this released workflow (id + input) so a run, job and session exist. */
  dispatch?: { workflowId: string; input: Record<string, unknown> };
}

/**
 * Seeds one realistic workspace through `brain.executeCommand` wherever a command exists: missions in
 * several states, a confirmed plan whose work items cover every state, a pending approval, a document and
 * optionally a dispatched run. Tickets, incidents, runners, sessions and verified evidence are produced by
 * connectors, runners and the evidence pipeline rather than by commands, so those few rows are inserted
 * directly. The actor must be a human with operator rights in a workspace that has an active release.
 */
export async function seedDemoWorkspace(brain: Brain, actor: ActorContext, workspaceId: string, options: DemoSeedOptions = {}): Promise<DemoSeed> {
  let counter = 0;
  const run = async (commandType: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const key = `demo-${commandType}-${++counter}`;
    const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: key, commandType, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    if (!receipt.accepted) throw new Error(`demo seed: ${commandType} was refused`);
    return receipt.resourceId ?? "";
  };
  const items = async (): Promise<WorkItem[]> => [...((await brain.executeQuery(actor, { queryType: "workItems.list", workspaceId, limit: 100 }) as unknown as { snapshot: { items: WorkItem[] } }).snapshot.items)];
  const item = async (planTaskId: string): Promise<WorkItem> => {
    const found = (await items()).find((candidate) => candidate.planTaskId === planTaskId);
    if (!found) throw new Error(`demo seed: work item ${planTaskId} is missing`);
    return found;
  };
  const transition = async (planTaskId: string, state: WorkItemState, extra: Record<string, unknown> = {}): Promise<void> => {
    const current = await item(planTaskId);
    await run("workItem.transition", { workItemId: current.workItemId, state, ...extra }, current.version);
  };

  // Missions: the paused and cancelled ones show the list in several states.
  const active = await run("mission.create", { title: "Stabilize authentication", intent: "Investigate and verify the sign-in flow", successCriteria: ["Independent evidence passes"] });
  const paused = await run("mission.create", { title: "Prepare the quarterly review", intent: "Collect the numbers the review needs", successCriteria: ["Review pack is complete"] });
  const closed = await run("mission.create", { title: "Retire legacy webhooks", intent: "Remove the unused webhook endpoints", successCriteria: ["No traffic reaches the old endpoints"] });
  await run("mission.pause", { missionId: paused }, 1);
  await run("mission.close", { missionId: closed, outcome: "cancelled" }, 1);

  // A confirmed plan, then a revision that drops one unstarted task so it becomes abandoned.
  const task = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, criteria: [`${id}-verified`], dependsOn });
  const everyTask = [task("done", "Audit sign-in sessions"), task("review", "Draft the correction"), task("progress", "Reproduce the latency regression"), task("blocked", "Collect production traces"), task("ready", "Write the rollout checklist"), task("backlog", "Announce the fix", ["ready"]), task("abandoned", "Rewrite the login page", ["ready"])];
  const first = await run("plan.propose", { missionId: active, origin: "manual", summary: "Audit, correct and verify the sign-in flow", tasks: everyTask });
  await run("plan.confirm", { planVersionId: first }, 1);
  const planVersionId = await run("plan.propose", { missionId: active, origin: "manual", summary: "Same plan without the page rewrite", tasks: everyTask.filter((entry) => entry.id !== "abandoned") });
  await run("plan.confirm", { planVersionId }, 2);

  // Walk each task to its state through the real transitions; execution links start work.
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  for (const id of ["done", "review", "progress"]) brain.missions.linkExecution(actor, workspaceId, (await item(id)).workItemId, `demo-run-${id}`);
  for (const id of ["done", "review"]) await transition(id, "review");
  const now = brain.store.now();
  ws.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?,'verified',?,?)").run(DIGEST, "demo-bundle", "demo-job", "demo-attempt", JSON.stringify({ workflowRunId: "demo-run-done", checks: [{ criterionId: "done-verified", status: "passed" }] }), now);
  ws.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES ('demo-verdict',?,'demo-evaluator',?,'verified','{}',?)").run(DIGEST, DIGEST, now);
  await run("handoff.submit", { workItemId: (await item("done")).workItemId, notes: { summary: "Sessions audited" } });
  await transition("done", "done", { evidenceDigest: DIGEST });
  // Block last: finishing a task re-readies blocked items whose dependencies are all done.
  await transition("blocked", "blocked", { reason: "Production traces are not exported yet" });

  // The work-item list hides abandoned items, so that one id is read from the table.
  const abandoned = ws.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='abandoned'").get(active) as { id: string };
  const workItems: Record<WorkItemState, string> = {
    backlog: (await item("backlog")).workItemId, ready: (await item("ready")).workItemId, "in-progress": (await item("progress")).workItemId,
    blocked: (await item("blocked")).workItemId, review: (await item("review")).workItemId, done: (await item("done")).workItemId, abandoned: abandoned.id,
  };

  // A pending approval, a document and the connector-fed rows (ticket, incident, runner).
  const approvalId = await run("approval.request", { subject: { organizationId: actor.organizationId, workspaceId, operation: "support.reply.publish", tool: { id: "support.publish", digest: DIGEST }, inputDigest: DIGEST, target: { targetId: "ticket-demo", environmentId: "production", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST, effectBounds: { ticketId: "ticket-demo", publication: "Exact reviewed response only" }, expiresAt: new Date(now + 3600_000).toISOString(), nonce: "demo-approval" } });
  const guide = "# SSO investigation guide\nCheck issuer, callback URL, session freshness and independent evidence.";
  const documentId = await run("document.upload", { title: "SSO investigation guide", fileName: "sso-guide.md", mediaType: "text/markdown", bytesBase64: Buffer.from(guide).toString("base64") });
  ws.prepare("INSERT INTO tickets(id,connector_id,remote_id,state,title,body_digest,source_version,observed_at_ms,priority) VALUES ('ticket-demo','support','42','open','Customer cannot sign in with SSO',?,'v1',?,'urgent')").run(DIGEST, now);
  ws.prepare("INSERT INTO incidents(id,target_key,severity,title,state,version,opened_at_ms) VALUES ('incident-demo','sso-production','critical','SSO sign-in latency regression','investigating',2,?)").run(now - 600_000);
  ws.prepare("INSERT INTO observations(id,connector_id,target_key,incident_id,observation_digest,source_event_id,observed_at_ms,expires_at_ms) VALUES ('observation-demo','monitoring','sso-production','incident-demo',?,'demo-observation',?,?)").run(DIGEST, now, now + 3600_000);
  const runnerId = "runner-demo";
  brain.store.control.prepare("INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity) VALUES (?,?,'agents','key','enabled','healthy',?,1,?,4000,8192,20480,4)").run(runnerId, actor.organizationId, DIGEST, now);
  for (const capability of ["os:linux", "engine:fixture", "tool:bash"]) brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES (?,?,1,'fixture',?,?)").run(runnerId, capability, now, now + 3600_000);

  const seed: DemoSeed = { missionIds: { active, paused, closed }, planVersionId, workItems, approvalId, ticketId: "ticket-demo", incidentId: "incident-demo", runnerId, documentId };
  if (options.dispatch) {
    const view = await brain.executeQuery(actor, { queryType: "workflows.list", workspaceId }) as unknown as { snapshot: { items: { release: { id: string; digest: string } }[] } };
    const workflow = view.snapshot.items.find((entry) => entry.release.id === options.dispatch!.workflowId);
    if (!workflow) throw new Error(`demo seed: workflow ${options.dispatch.workflowId} is not in the active release`);
    const runId = await run("workflow.dispatch", { workflow: workflow.release, input: options.dispatch.input });
    const job = brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(runId) as { id: string } | undefined;
    if (!job) throw new Error("demo seed: the dispatch created no job");
    const sessionId = `session-${createHash("sha256").update(runId).digest("hex").slice(0, 8)}`;
    ws.prepare("INSERT INTO sessions(id,job_id,attempt_id,engine_id,adapter_digest,state,event_sequence,updated_at_ms) VALUES (?,?,'attempt-demo','fixture',?,'running',0,?)").run(sessionId, job.id, DIGEST, now);
    seed.run = { runId, jobId: job.id, sessionId };
  }
  return seed;
}
