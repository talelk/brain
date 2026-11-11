import type { ActorContext, JsonValue, Placement } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { evaluateRunner, rankRunners } from "../../domain/placement";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import type { QuerySnapshot } from "../../application/query";
import { isReadOnlyReasoningJob, runnerView } from "./attempts";
import { jobNeedsYou, runContext, type RunContext } from "./run-context";

export interface JobAttemptView {
  attemptId: string;
  number: number;
  runnerId: string;
  state: string;
  leaseExpiresAt?: string;
}

/** The job read model: one row joined to its attempts, run outputs and evidence. */
export interface JobSnapshotView {
  jobId: string;
  organizationId: string;
  workspaceId: string;
  workflowRunId: string;
  state: string;
  version: number;
  queueReasons: string[];
  placement: JsonValue;
  attempts: JobAttemptView[];
  configDigest: string;
  createdAt: string;
  runState?: string;
  /** The Governor is restarting an interrupted read-only step by itself: the run is not running right now, and nobody needs to act. */
  restarting?: boolean;
  workflowTitle?: string;
  /** The task and mission behind this run, and the later event that settled it, if any. */
  context?: RunContext;
  /** The one rule shared with Today's Needs-you queue: an unresolved stuck or failed run. */
  needsYou: boolean;
  origin?: JsonValue;
  runOutputs: JsonValue;
  engineEvents: JsonValue[];
  evidenceDigest?: string;
  sessionId?: string;
}

/**
 * True while an interrupted read-only step waits to be started again: queued for its restart, or left outcome unknown during the
 * short cooldown before the automatic retry. The run itself still reads "running", which is wrong for that moment.
 */
function isRestarting(store: Store, row: Record<string, unknown>): boolean {
  const state = String(row["state"]);
  if (state === "queued") return row["queue_reason"] === "RESTARTED_AFTER_INTERRUPTION";
  if (state !== "outcome_unknown") return false;
  const attempt = store.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND job_fence=? ORDER BY attempt_no DESC LIMIT 1").get(String(row["id"]), Number(row["job_fence"])) as { id: string } | undefined;
  return attempt !== undefined && isReadOnlyReasoningJob(store, String(row["id"]), attempt.id);
}

/**
 * Server-resolved session binding: the inspector links to the live console
 * without guessing session ids from attempt ids.
 */
export function jobSnapshot(store: Store, row: Record<string, unknown>): JobSnapshotView {
  const attempts = store.control.prepare("SELECT id, runner_id, attempt_no, state, lease_expires_at_ms FROM job_attempts WHERE job_id=? ORDER BY attempt_no").all(String(row["id"])) as Array<Record<string, unknown>>;
  const ws = store.workspaceDb(String(row["workspace_id"]), String(row["organization_id"]));
  const boundSession = ws.prepare("SELECT id FROM sessions WHERE job_id=? ORDER BY updated_at_ms DESC LIMIT 1").get(String(row["id"])) as { id: string } | undefined;
  const runId = String(row["workflow_run_id"]);
  const runState = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string } | undefined;
  const workflow = ws.prepare("SELECT json_extract(workflow_json,'$.spec.presentation.title') AS title,json_extract(workflow_json,'$.metadata.id') AS id FROM run_inputs WHERE run_id=?").get(runId) as { title: string | null; id: string } | undefined;
  const origin = ws.prepare("SELECT origin_json FROM task_drafts WHERE run_id=? AND origin_json IS NOT NULL LIMIT 1").get(runId) as { origin_json: string } | undefined;
  const outputs = ws.prepare("SELECT step_id,output_json FROM step_outputs WHERE run_id=?").all(runId) as { step_id: string; output_json: string }[];
  const events = store.control.prepare("SELECT e.event_json FROM attempt_events e JOIN job_attempts a ON a.id=e.attempt_id JOIN jobs j ON j.id=a.job_id WHERE j.organization_id=? AND j.workflow_run_id=? AND json_extract(e.event_json,'$.kind')='engine' ORDER BY j.created_at_ms DESC,e.seq DESC LIMIT 200").all(String(row["organization_id"]), runId) as { event_json: string }[];
  const bundle = ws.prepare("SELECT digest FROM evidence_bundles WHERE json_extract(manifest_json,'$.workflowRunId')=? ORDER BY created_at_ms DESC LIMIT 1").get(runId) as { digest: string } | undefined;
  const context = runContext(ws, runId, String(row["state"]));
  const restarting = isRestarting(store, row);
  const view: JobSnapshotView = {
    jobId: String(row["id"]),
    organizationId: String(row["organization_id"]),
    workspaceId: String(row["workspace_id"]),
    workflowRunId: String(row["workflow_run_id"]),
    state: String(row["state"]),
    version: Number(row["version"]),
    queueReasons: ["queued", "blocked"].includes(String(row["state"])) && row["queue_reason"] ? [String(row["queue_reason"])] : [],
    placement: JSON.parse(String(row["placement_json"])) as JsonValue,
    attempts: attempts.map((a) => ({
      attemptId: String(a["id"]),
      number: Number(a["attempt_no"]),
      runnerId: String(a["runner_id"]),
      state: String(a["state"]),
      ...(a["lease_expires_at_ms"] != null ? { leaseExpiresAt: iso(Number(a["lease_expires_at_ms"])) } : {}),
    })),
    configDigest: String(row["config_digest"]),
    createdAt: iso(Number(row["created_at_ms"])),
    ...(runState ? { runState: runState.state } : {}),
    ...(restarting ? { restarting: true } : {}),
    needsYou: jobNeedsYou(String(row["state"]), restarting, context),
    ...(context ? { context } : {}),
    ...(workflow ? { workflowTitle: workflow.title ?? workflow.id.replaceAll("-", " ") } : {}),
    ...(origin ? { origin: JSON.parse(origin.origin_json) as JsonValue } : {}),
    runOutputs: Object.fromEntries(outputs.map((entry) => [entry.step_id, JSON.parse(entry.output_json)])) as JsonValue,
    engineEvents: events.reverse().map((entry) => {
      const payload = (JSON.parse(entry.event_json) as { payload: JsonValue }).payload as { kind?: string; artifact?: { artifactId: string; digest: string } };
      if (payload.kind === "artifact" && payload.artifact) {
        const stored = ws.prepare("SELECT id FROM artifacts WHERE digest=? ORDER BY created_at_ms DESC LIMIT 1").get(payload.artifact.digest) as { id: string } | undefined;
        if (stored) return { ...payload, artifact: { ...payload.artifact, artifactId: stored.id } } as unknown as JsonValue;
      }
      return payload as unknown as JsonValue;
    }),
    ...(bundle ? { evidenceDigest: bundle.digest } : {}),
    ...(boundSession ? { sessionId: boundSession.id } : {}),
  };
  return view;
}

/**
 * Resolve a /runs/:id resource: a job id names one row, and a workflow run id
 * resolves to that run's current (newest) job — dispatch receipts name the
 * run, so a deep link opens the work and follows it across steps.
 */
export function jobRowFor(store: Store, actor: ActorContext, resourceId: string): Record<string, unknown> | undefined {
  return store.control.prepare(
    "SELECT * FROM jobs WHERE organization_id=? AND (id=? OR workflow_run_id=?) ORDER BY created_at_ms DESC, id DESC LIMIT 1",
  ).get(actor.organizationId, resourceId, resourceId) as Record<string, unknown> | undefined;
}

export interface JobListFilters {
  states?: string[] | undefined;
  search?: string | undefined;
  cursor?: string | undefined;
}

/** jobs.list: the filtered, cursor-paginated job page across the allowed workspaces. */
export function listJobs(
  store: Store,
  actor: ActorContext,
  workspaceIds: readonly string[],
  limit: number,
  filters: JobListFilters = {},
): QuerySnapshot {
  if (workspaceIds.length === 0) return { snapshot: { items: [] } as unknown as JsonValue };
  const marks = workspaceIds.map(() => "?").join(",");
  const clauses = [`organization_id=?`, `workspace_id IN (${marks})`];
  const parameters: Array<string | number> = [actor.organizationId, ...workspaceIds];
  if (filters.states?.length) { clauses.push(`state IN (${filters.states.map(() => "?").join(",")})`); parameters.push(...filters.states); }
  if (filters.search) { clauses.push("(LOWER(id) LIKE ? OR LOWER(workflow_run_id) LIKE ?)"); const search = `%${filters.search.toLowerCase()}%`; parameters.push(search, search); }
  if (filters.cursor) {
    try {
      const position = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as { createdAt: number; id: string };
      clauses.push("(created_at_ms<? OR (created_at_ms=? AND id<?))"); parameters.push(position.createdAt, position.createdAt, position.id);
    } catch { throw new BrainDomainError("INVALID_ARGUMENT", "invalid jobs cursor"); }
  }
  const where = clauses.join(" AND ");
  const rows = store.control.prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at_ms DESC, id DESC LIMIT ?`).all(...parameters, limit + 1) as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const cursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: Number(last["created_at_ms"]), id: String(last["id"]) })).toString("base64url") : "";
  const total = store.control.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE ${clauses.filter((clause) => !clause.startsWith("(created_at_ms")).join(" AND ")}`).get(...parameters.slice(0, parameters.length - (filters.cursor ? 3 : 0))) as { count: number };
  return {
    snapshot: { items: page.map((row) => jobSnapshot(store, row)), totalEstimate: total.count } as unknown as JsonValue,
    cursor,
  };
}

/** job.get: one job (or the newest job of a run) with its full snapshot. */
export function getJob(store: Store, actor: ActorContext, resourceId: string): JsonValue {
  const row = jobRowFor(store, actor, resourceId);
  if (!row) throw new BrainDomainError("NOT_FOUND", "job or run not found");
  requireWorkspaceRead(store, actor, String(row["workspace_id"]));
  return jobSnapshot(store, row) as unknown as JsonValue;
}

export interface RunnerPlacementVerdict {
  runnerId: string;
  eligible: boolean;
  reasons: readonly string[];
}

export interface JobExplainView {
  jobId: string;
  jobVersion: number;
  evaluatedAt: string;
  primaryReason: string;
  reasons: readonly string[];
  runners: RunnerPlacementVerdict[];
}

/**
 * job.explain: why this job is where it is, judged against the whole fleet.
 * A job that is executing or verifying still reports the truth about the
 * fleet: if no runner is eligible right now, claiming READY would contradict
 * the eligibility table shown directly below it.
 */
export function explainJob(store: Store, actor: ActorContext, resourceId: string): JobExplainView {
  const row = jobRowFor(store, actor, resourceId);
  if (!row) throw new BrainDomainError("NOT_FOUND", "job or run not found");
  requireWorkspaceRead(store, actor, String(row["workspace_id"]));
  const placement = JSON.parse(String(row["placement_json"])) as Placement;
  const demand = placement.resources ?? { cpuMillicores: 500, memoryMb: 512, diskMb: 512, slots: 1 };
  const runners = (store.control.prepare("SELECT id FROM runners WHERE organization_id=?").all(actor.organizationId) as Array<{ id: string }>)
    .map((r) => runnerView(store, r.id)).filter((v): v is NonNullable<typeof v> => !!v)
    .sort(rankRunners)
    .map((v) => { const verdict = evaluateRunner(placement, demand, v, store.now()); return { runnerId: v.id, eligible: verdict.eligible, reasons: verdict.reasons }; });
  const anyEligible = runners.some((r) => r.eligible);
  const allOffline = runners.length > 0 && runners.every((r) => r.reasons.includes("runner-offline"));
  const primary = anyEligible ? "READY" : runners.length === 0 ? "WAITING_FOR_RUNNER" : allOffline ? "RUNNER_OFFLINE" : "INSUFFICIENT_CAPACITY";
  return {
    jobId: String(row["id"]), jobVersion: Number(row["version"]), evaluatedAt: store.nowIso(),
    primaryReason: primary, reasons: [primary], runners,
  };
}

export interface RunnerSummaryView {
  runnerId: string;
  group: string;
  adminState: string;
  connectivity: string;
  health: string;
  displayStatus: string;
  capacity: JsonValue;
  reserved: JsonValue;
  observedFree: JsonValue;
  capabilities: Array<Record<string, JsonValue>>;
  engines: Array<Record<string, JsonValue>>;
  activeAttemptIds: string[];
  lastSeenAt: string;
  deregisteredAt?: string;
}

function runnerSummary(store: Store, organizationId: string, runnerId: string): RunnerSummaryView | undefined {
  const meta = store.control.prepare("SELECT last_heartbeat_ms,deregistered_at_ms FROM runners WHERE id=? AND organization_id=?").get(runnerId, organizationId) as { last_heartbeat_ms: number | null; deregistered_at_ms: number | null } | undefined;
  const v = runnerView(store, runnerId);
  if (!v || !meta) return undefined;
  const display = v.adminState === "disabled" ? "disabled" : v.adminState === "quarantined" ? "quarantined" : v.adminState === "draining" ? "draining" : !v.online ? "offline" : v.reserved.slots > 0 ? "busy" : "idle";
  const activeAttemptIds = (store.control.prepare("SELECT id FROM job_attempts WHERE runner_id=? AND state IN ('offered','running','uploading','cancelling','verifying','outcome_unknown') ORDER BY id LIMIT 1024").all(runnerId) as Array<{ id: string }>).map((attempt) => attempt.id);
  return {
    runnerId, group: v.groupId, adminState: v.adminState, connectivity: v.online ? "online" : "offline",
    health: v.health, displayStatus: display, capacity: v.capacity as unknown as JsonValue,
    reserved: { cpuMillicores: v.reserved.cpuMillicores, memoryMb: v.reserved.memoryMb, diskMb: v.reserved.diskMb, slots: v.reserved.slots } as unknown as JsonValue,
    observedFree: { cpuMillicores: Math.max(0, v.capacity.cpuMillicores - v.reserved.cpuMillicores), memoryMb: Math.max(0, v.capacity.memoryMb - v.reserved.memoryMb), diskMb: Math.max(0, v.capacity.diskMb - v.reserved.diskMb), slots: Math.max(0, v.capacity.slots - v.reserved.slots) } as unknown as JsonValue,
    capabilities: [...v.capabilities.entries()].map(([capability, c]) => ({ capability, observedAt: store.nowIso(), source: "runner-probe", verified: c.verified, expiresAt: iso(c.expiresAtMs) })),
    engines: v.engines.map((e) => ({ id: e, version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] })),
    activeAttemptIds, lastSeenAt: iso(meta.last_heartbeat_ms ?? 0),
    ...(meta.deregistered_at_ms ? { deregisteredAt: iso(meta.deregistered_at_ms) } : {}),
  };
}

/** runners.list: the registered fleet with live capacity and attempt occupancy. */
export function listRunners(store: Store, actor: ActorContext, limit: number): JsonValue {
  const ids = (store.control.prepare("SELECT id FROM runners WHERE organization_id=? AND deregistered_at_ms IS NULL ORDER BY id LIMIT ?").all(actor.organizationId, limit) as Array<{ id: string }>).map((r) => r.id);
  const items = ids.map((id) => runnerSummary(store, actor.organizationId, id)).filter((v): v is RunnerSummaryView => !!v);
  return { items } as unknown as JsonValue;
}

/** runner.get: one runner's summary; a deregistered runner is still addressable. */
export function getRunner(store: Store, actor: ActorContext, runnerId: string): JsonValue {
  const v = runnerSummary(store, actor.organizationId, runnerId);
  if (!v) throw new BrainDomainError("NOT_FOUND", "runner not found");
  return v as unknown as JsonValue;
}

/** search.global helper: jobs whose id, run id or state match. */
export function searchJobs(
  store: Store,
  organizationId: string,
  workspaceId: string,
  matches: (value: unknown) => boolean,
): Array<Record<string, JsonValue>> {
  const jobs = store.control.prepare("SELECT id,workflow_run_id,state,created_at_ms FROM jobs WHERE organization_id=? AND workspace_id=? ORDER BY created_at_ms DESC LIMIT 100").all(organizationId, workspaceId) as Array<{ id: string; workflow_run_id: string; state: string; created_at_ms: number }>;
  const results: Array<Record<string, JsonValue>> = [];
  for (const job of jobs) {
    if (matches(job.id) || matches(job.workflow_run_id) || matches(job.state)) {
      results.push({ category: "run", title: `Run ${job.workflow_run_id}`, reason: `${job.state} · job ${job.id}`, resourceId: job.id, workspaceId, updatedAt: iso(job.created_at_ms) });
    }
  }
  return results;
}
