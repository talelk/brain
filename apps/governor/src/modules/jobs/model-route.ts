import type { Store } from "../../application/store";

/**
 * Hosted model routing (ADR 0023). A workspace that switched the hosted model on gets it for exactly two roles: the independent
 * check (evaluator step) and the second attempt of a task whose first attempt failed as a model slip. Planning and first attempts stay
 * self-hosted. The route names where to call and never carries a credential: the key lives in the runner's own environment.
 */
export interface ModelRoute {
  readonly tier: "hosted";
  readonly role: "evaluator" | "second-attempt";
  readonly vendor: string;
  readonly model: string;
  readonly baseUrl: string;
}

export interface HostedConfig { readonly enabled: boolean; readonly vendor: string; readonly model: string; readonly baseUrl: string }

/** The workspace's hosted model settings; off when never configured. */
export function hostedConfig(s: Store, workspaceId: string): HostedConfig {
  const row = s.control.prepare("SELECT enabled, vendor, model, base_url FROM workspace_hosted_model WHERE workspace_id=?").get(workspaceId) as { enabled: number; vendor: string; model: string; base_url: string } | undefined;
  return row ? { enabled: row.enabled === 1, vendor: row.vendor, model: row.model, baseUrl: row.base_url } : { enabled: false, vendor: "", model: "", baseUrl: "" };
}

/** The route for one job, or nothing (self-hosted). `kind` is the job payload kind: `eval` is the check, `dispatch` an agent step. */
export function modelRouteFor(s: Store, organizationId: string, workspaceId: string, runId: string, kind: string): ModelRoute | undefined {
  const config = hostedConfig(s, workspaceId);
  if (!config.enabled || !config.model || !config.baseUrl) return undefined;
  const route = (role: ModelRoute["role"]): ModelRoute => ({ tier: "hosted", role, vendor: config.vendor, model: config.model, baseUrl: config.baseUrl });
  if (kind === "eval") return route("evaluator");
  if (kind !== "dispatch") return undefined;
  try {
    const db = s.workspaceDb(workspaceId, organizationId);
    const second = db.prepare(`SELECT 1 FROM execution_links l JOIN work_items w ON w.id=l.work_item_id
      WHERE l.run_id=? AND w.failed_attempts>=1 AND w.failure_class='model-slip' LIMIT 1`).get(runId);
    return second ? route("second-attempt") : undefined;
  } catch { return undefined; }
}

/** True when the job would run on the hosted model and that model is down: its checks and second attempts wait (ADR 0023). */
export function heldForHostedModel(s: Store, organizationId: string, workspaceId: string, runId: string, kindOf: () => string): boolean {
  if (!s.control.prepare("SELECT 1 FROM service_probes WHERE id=? AND status='unavailable'").get(`hosted:${workspaceId}`)) return false;
  return modelRouteFor(s, organizationId, workspaceId, runId, kindOf()) !== undefined;
}
