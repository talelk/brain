import { COST_TIERS, costTierRank, isKeyReference, type CostTier } from "@brain/contracts";
import { QUOTA_MAX_WAIT_MS, QUOTA_MIN_WAIT_MS, quotaWaitMs } from "../../domain/failure";
import type { Store } from "../../application/store";

/**
 * Model routes (ADR 0055, builds on ADR 0023). A workspace holds an ordered list of hosted model routes. A job uses them for exactly three
 * roles: the independent check (evaluator step), the second attempt of a task whose first attempt failed as a model slip, and the advisory
 * judge. Planning and first attempts stay self-hosted. A route names where to call and which key to use by reference; it never carries a
 * credential: the key lives in the caller's own environment.
 */
export type ModelRouteRole = "evaluator" | "second-attempt" | "judge";

/** One route as the owner configured it. */
export interface ModelRouteConfig {
  readonly routeId: string;
  readonly enabled: boolean;
  readonly vendor: string;
  readonly keyRef: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly costTier: CostTier;
  /** What the model costs, in micro-USD per million tokens: the caller prices tokens with these, so the spend caps see real dollars. */
  readonly inputMicroUsdPerMTok: number;
  readonly outputMicroUsdPerMTok: number;
}

/** One route as a job or the judge is handed it. */
export interface ModelRoute extends ModelRouteConfig {
  readonly tier: "hosted";
  readonly role: ModelRouteRole;
}

/** What an agent definition asks for: routes it prefers (tried first, in this order) and the dearest cost tier it accepts. */
export interface RoutePreference { readonly routes?: readonly string[] | undefined; readonly costTier?: CostTier | undefined }

/** The workspace's routes in the order the owner set. */
export function modelRoutesOf(s: Store, workspaceId: string): ModelRouteConfig[] {
  return (s.control.prepare(`SELECT route_id, enabled, vendor, key_ref, model, base_url, cost_tier, input_micro_usd_per_mtok AS input, output_micro_usd_per_mtok AS output
    FROM workspace_model_routes WHERE workspace_id=? ORDER BY position`).all(workspaceId) as Array<{ route_id: string; enabled: number; vendor: string; key_ref: string; model: string; base_url: string; cost_tier: CostTier; input: number; output: number }>)
    .map((row) => ({ routeId: row.route_id, enabled: row.enabled === 1, vendor: row.vendor, keyRef: row.key_ref, model: row.model, baseUrl: row.base_url, costTier: row.cost_tier, inputMicroUsdPerMTok: row.input, outputMicroUsdPerMTok: row.output }));
}

/** Whether a route is switched on, described, priced and names a key: only then does any role use it. */
export function routeUsable(route: ModelRouteConfig): boolean {
  return route.enabled && !!route.model && !!route.baseUrl && route.inputMicroUsdPerMTok >= 1 && route.outputMicroUsdPerMTok >= 1 && isKeyReference(route.keyRef);
}

/** The workspace's routes that are switched on and complete, in order. */
export function usableRoutes(s: Store, workspaceId: string): ModelRouteConfig[] {
  return modelRoutesOf(s, workspaceId).filter(routeUsable);
}

/** Whether the workspace has any usable route: the switch the owner's settings, the plan bundle and the judge read. */
export function modelRoutesUsable(s: Store, workspaceId: string): boolean {
  return usableRoutes(s, workspaceId).length > 0;
}

export const routeProbeId = (workspaceId: string, routeId: string): string => `hosted:${workspaceId}/${routeId}`;

/** Until when a route's account is out of quota, or undefined when it is not. */
export function routeCooldownUntil(s: Store, workspaceId: string, routeId: string): number | undefined {
  const row = s.control.prepare("SELECT until_ms FROM model_route_cooldowns WHERE workspace_id=? AND route_id=?").get(workspaceId, routeId) as { until_ms: number } | undefined;
  return row && row.until_ms > s.now() ? row.until_ms : undefined;
}

function routeDown(s: Store, workspaceId: string, routeId: string): boolean {
  return s.control.prepare("SELECT 1 FROM service_probes WHERE id=? AND status='unavailable'").get(routeProbeId(workspaceId, routeId)) !== undefined;
}

/** Usable routes the agent accepts, in the order they are tried: the agent's preferred routes first, then the workspace's order. */
export function routesForPreference(routes: readonly ModelRouteConfig[], preference: RoutePreference | undefined): ModelRouteConfig[] {
  const ceiling = preference?.costTier ? costTierRank(preference.costTier) : COST_TIERS.length;
  const accepted = routes.filter((route) => costTierRank(route.costTier) <= ceiling);
  const named = preference?.routes ?? [];
  return [
    ...named.flatMap((id) => accepted.filter((route) => route.routeId === id)),
    ...accepted.filter((route) => !named.includes(route.routeId)),
  ];
}

/**
 * The routes a role may call right now, in order: usable, accepted by the agent, not down and not out of quota. `blocked` says routes would
 * serve the role but every one of them is down or cooling, so the work waits for one instead of falling back to the self-hosted model.
 */
export function eligibleRoutes(s: Store, workspaceId: string, role: ModelRouteRole, preference?: RoutePreference): { routes: ModelRoute[]; blocked: boolean; retryAtMs?: number } {
  const candidates = routesForPreference(usableRoutes(s, workspaceId), preference);
  const available = candidates.filter((route) => !routeDown(s, workspaceId, route.routeId) && routeCooldownUntil(s, workspaceId, route.routeId) === undefined);
  const cooling = candidates.map((route) => routeCooldownUntil(s, workspaceId, route.routeId)).filter((until): until is number => until !== undefined);
  return {
    routes: available.map((route) => ({ ...route, tier: "hosted", role })),
    blocked: candidates.length > 0 && available.length === 0,
    ...(available.length === 0 && cooling.length > 0 ? { retryAtMs: Math.min(...cooling) } : {}),
  };
}

/** A route's account ran out of quota or rate: it is left out of every offer until the provider's retry-after has passed. */
export function markRouteQuota(s: Store, workspaceId: string, routeId: string, retryAfterMs: number | undefined, reason: string): void {
  const wait = retryAfterMs === undefined ? quotaWaitMs("") : Math.min(QUOTA_MAX_WAIT_MS, Math.max(QUOTA_MIN_WAIT_MS, retryAfterMs));
  s.control.prepare(`INSERT INTO model_route_cooldowns(workspace_id,route_id,until_ms,reason) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,route_id) DO UPDATE SET until_ms=MAX(until_ms, excluded.until_ms), reason=excluded.reason`).run(workspaceId, routeId, s.now() + wait, reason.slice(0, 200));
}

/** What an attempt did with each route it tried, in order: the one that served it and any it moved past. Written once per subject. */
export function recordRouteUses(s: Store, subjectId: string, workspaceId: string, uses: ReadonlyArray<{ routeId: string; model: string; outcome: "served" | "quota" | "failed" }>): void {
  const insert = s.control.prepare("INSERT OR IGNORE INTO attempt_model_routes(attempt_id,position,route_id,workspace_id,model,outcome,recorded_at_ms) VALUES (?,?,?,?,?,?,?)");
  uses.forEach((use, position) => { insert.run(subjectId, position, use.routeId, workspaceId, use.model, use.outcome, s.now()); });
}

/** The routes an attempt tried, in order, for the run inspector. */
export function attemptRouteUses(s: Store, attemptId: string): Array<{ routeId: string; model: string; outcome: "served" | "quota" | "failed" }> {
  return (s.control.prepare("SELECT route_id, model, outcome FROM attempt_model_routes WHERE attempt_id=? ORDER BY position").all(attemptId) as Array<{ route_id: string; model: string; outcome: "served" | "quota" | "failed" }>)
    .map((row) => ({ routeId: row.route_id, model: row.model, outcome: row.outcome }));
}

export interface JobRouteContext { readonly organizationId: string; readonly workspaceId: string; readonly runId: string; readonly kind: string; readonly configDigest: string; readonly agentId: string | undefined }

function jobContext(s: Store, jobId: string): JobRouteContext | undefined {
  const row = s.control.prepare(`SELECT j.organization_id, j.workspace_id, j.workflow_run_id, j.config_digest, p.kind, p.payload_json FROM jobs j LEFT JOIN job_payloads p ON p.job_id=j.id WHERE j.id=?`).get(jobId) as
    { organization_id: string; workspace_id: string; workflow_run_id: string; config_digest: string; kind: string | null; payload_json: string | null } | undefined;
  if (!row) return undefined;
  let agentId: string | undefined;
  try { agentId = (JSON.parse(row.payload_json ?? "{}") as { step?: { uses?: { type?: string; release?: { id?: string } } } }).step?.uses?.release?.id; } catch { agentId = undefined; }
  return { organizationId: row.organization_id, workspaceId: row.workspace_id, runId: row.workflow_run_id, kind: row.kind ?? "", configDigest: row.config_digest, agentId };
}

/**
 * What the runner reports when an attempt ends: each route it tried in order and how it went. Only routes the job was offered count (the
 * payload pinned them), the served one is recorded for the attempt, and a route that refused for quota is left out of later offers until
 * the provider's retry-after has passed. A report naming anything else is ignored.
 */
export function settleRouteReport(s: Store, input: { attemptId: string; jobId: string; workspaceId: string; report: unknown }): void {
  if (!Array.isArray(input.report)) return;
  const pinned = (() => {
    try { return (JSON.parse((s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(input.jobId) as { payload_json: string } | undefined)?.payload_json ?? "{}") as { modelRoutes?: Array<{ routeId: string; model: string }> }).modelRoutes ?? []; } catch { return []; }
  })();
  const uses: Array<{ routeId: string; model: string; outcome: "served" | "quota" | "failed" }> = [];
  for (const entry of input.report as Array<{ routeId?: unknown; outcome?: unknown; retryAfterMs?: unknown }>) {
    const route = pinned.find((candidate) => candidate.routeId === entry.routeId);
    if (!route || (entry.outcome !== "served" && entry.outcome !== "quota" && entry.outcome !== "failed") || uses.some((use) => use.routeId === route.routeId)) continue;
    uses.push({ routeId: route.routeId, model: route.model, outcome: entry.outcome });
    // The usage ledger attributes spend to the model that answered (#111): the runner named the first route when it took the attempt, and a failover can end on another.
    if (entry.outcome === "served") s.control.prepare("UPDATE job_attempts SET reported_model=? WHERE id=?").run(route.model, input.attemptId);
    if (entry.outcome === "quota") markRouteQuota(s, input.workspaceId, route.routeId, typeof entry.retryAfterMs === "number" && entry.retryAfterMs > 0 ? entry.retryAfterMs : undefined, "the provider refused for quota or rate");
  }
  recordRouteUses(s, input.attemptId, input.workspaceId, uses);
}

/** What the agent definition of a release asks of the routes; nothing when the release or the agent does not say. */
export function agentRoutePreference(s: Store, configDigest: string, agentId: string | undefined): RoutePreference | undefined {
  if (!agentId) return undefined;
  const row = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(configDigest) as { manifest_json: string } | undefined;
  if (!row) return undefined;
  try {
    const spec = (JSON.parse(row.manifest_json) as { agents?: Record<string, { spec?: { modelRoutes?: string[]; costTier?: CostTier } }> }).agents?.[agentId]?.spec;
    return spec && (spec.modelRoutes?.length || spec.costTier) ? { routes: spec.modelRoutes, costTier: spec.costTier } : undefined;
  } catch { return undefined; }
}

/** The role a job would use the routes for, or nothing (self-hosted): `eval` is the check, `dispatch` an agent step. */
function roleOf(s: Store, ctx: JobRouteContext): "evaluator" | "second-attempt" | undefined {
  if (ctx.kind === "eval") return "evaluator";
  if (ctx.kind !== "dispatch") return undefined;
  try {
    const db = s.workspaceDb(ctx.workspaceId, ctx.organizationId);
    const second = db.prepare(`SELECT 1 FROM execution_links l JOIN work_items w ON w.id=l.work_item_id
      WHERE l.run_id=? AND w.failed_attempts>=1 AND w.failure_class='model-slip' LIMIT 1`).get(ctx.runId);
    return second ? "second-attempt" : undefined;
  } catch { return undefined; }
}

/** The routes a job of this kind is offered, in order, and whether it must wait. `kind` is the job payload kind: `eval` is the check, `dispatch` an agent step. */
export function modelRoutesFor(s: Store, ctx: JobRouteContext): { routes: ModelRoute[]; held: boolean; retryAtMs?: number } {
  const none = { routes: [] as ModelRoute[], held: false };
  if (!modelRoutesUsable(s, ctx.workspaceId)) return none;
  const role = roleOf(s, ctx);
  if (!role) return none;
  const eligible = eligibleRoutes(s, ctx.workspaceId, role, agentRoutePreference(s, ctx.configDigest, ctx.agentId));
  return { routes: eligible.routes, held: eligible.blocked, ...(eligible.retryAtMs !== undefined ? { retryAtMs: eligible.retryAtMs } : {}) };
}

/**
 * The routes one queued job is offered, in the order they are tried, and whether the job must wait because every route that would serve it is
 * down or out of quota. A job of no hosted role, or of a workspace with no usable route, runs self-hosted: no routes, not held.
 */
export function modelRoutesForJob(s: Store, jobId: string): { routes: ModelRoute[]; held: boolean; retryAtMs?: number } {
  const ctx = jobContext(s, jobId);
  return ctx ? modelRoutesFor(s, ctx) : { routes: [], held: false };
}
