import type { Store } from "../../application/store";
import { DEFAULT_TASK_TOKEN_CAP, outageLike } from "../../domain/failure";
import { activeReleaseRecord } from "../configuration/index";
import { settle } from "./budget";
import { taskUsage } from "./usage";

type Db = ReturnType<Store["workspaceDb"]>;

/** Recorded calls of a set of tools in the runs of one task: what Done (ADR 0022) is decided from, never a model. */
export interface ObservedCalls { readonly succeeded: number; readonly failed: number; readonly outageLike: number }

/**
 * A call counts as successful only when it finished without failing. A call that never recorded a result (the attempt ended
 * mid-call) is a failed one that looks like an outage. Tool-test runs are tagged apart and never counted: they are not task runs.
 */
export function observedCalls(store: Store, db: Db, workItemId: string, tools: readonly string[], onlyRun?: string): ObservedCalls {
  const none: ObservedCalls = { succeeded: 0, failed: 0, outageLike: 0 };
  if (tools.length === 0) return none;
  // One run's calls when asked (a candidate answers for its own run only, ADR 0071); else every run of the task.
  const runs = onlyRun ? [onlyRun] : (db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(workItemId) as Array<{ run_id: string }>).map((row) => row.run_id);
  if (runs.length === 0) return none;
  const rows = store.control.prepare(`SELECT failed, finished_at, failure_message FROM tool_calls WHERE run_id IN (${runs.map(() => "?").join(",")}) AND tool_id IN (${tools.map(() => "?").join(",")})`)
    .all(...runs, ...tools) as Array<{ failed: number; finished_at: string | null; failure_message: string | null }>;
  const total = { ...none } as { succeeded: number; failed: number; outageLike: number };
  for (const row of rows) {
    if (row.failed === 0 && row.finished_at) { total.succeeded++; continue; }
    total.failed++;
    if (row.failed === 0 || outageLike(row.failure_message)) total.outageLike++;
  }
  return total;
}

/** Tools that read stored claims (ADR 0022): reusing earlier knowledge is never observation of the world, so such a call alone never backs a result. */
const CLAIM_READ_TOOLS: readonly string[] = ["knowledge.search"];

/** Whether a mission rests on observation: no Done task lacks the call it declared, and at least one successful call of an observing tool exists across its runs. */
export function missionObserved(store: Store, db: Db, missionId: string): boolean {
  const items = db.prepare("SELECT id, required_tools_json FROM work_items WHERE mission_id=? AND state='done'").all(missionId) as Array<{ id: string; required_tools_json: string }>;
  if (items.length === 0) return false;
  let any = false;
  for (const item of items) {
    const declared = JSON.parse(item.required_tools_json) as string[];
    if (declared.length > 0 && observedCalls(store, db, item.id, declared).succeeded === 0) return false;
    if (!any) {
      const runs = (db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(item.id) as Array<{ run_id: string }>).map((row) => row.run_id);
      if (runs.length > 0 && (store.control.prepare(`SELECT 1 FROM tool_calls WHERE failed=0 AND finished_at IS NOT NULL AND tool_id NOT IN (${CLAIM_READ_TOOLS.map(() => "?").join(",")}) AND run_id IN (${runs.map(() => "?").join(",")}) LIMIT 1`).get(...CLAIM_READ_TOOLS, ...runs) !== undefined)) any = true;
    }
  }
  return any;
}

/** The task's spend cap in tokens across all attempts (owner-raised for one task, else the default). */
export const taskTokenCap = (row: { token_cap: number | null }): number => row.token_cap ?? DEFAULT_TASK_TOKEN_CAP;

/** Tokens a task has used or reserved across all its attempts. */
export function taskTokens(store: Store, db: Db, workItemId: string): number {
  // The ledger settles lazily (when something reads it), so settle this task's mission first: an attempt that just ended must count.
  const mission = db.prepare("SELECT mission_id FROM work_items WHERE id=?").get(workItemId) as { mission_id: string } | undefined;
  if (mission) settle(store, db, mission.mission_id);
  const usage = taskUsage(db, workItemId);
  return usage.settledTokens + usage.reservedTokens;
}

/** Tools of the agents the workflow dispatches to, or undefined when the workflow is not in the active release. */
export function workflowAgentTools(store: Store, organizationId: string, workflowId: string): string[] | undefined {
  const release = activeReleaseRecord(store, organizationId)?.release;
  const workflow = release?.workflows?.[workflowId];
  if (!release || !workflow) return undefined;
  const tools = new Set<string>();
  for (const step of Object.values(workflow.spec.jobs)) {
    if (step.kind !== "dispatch" || step.uses.type !== "agent") continue;
    for (const tool of release.agents?.[step.uses.release.id]?.spec.tools ?? []) tools.add(tool.id);
  }
  return [...tools].sort();
}

/** Workflows of the active release, in id order, whose agents carry every tool in the list. */
export function workflowsCovering(store: Store, organizationId: string, tools: readonly string[]): string[] {
  const release = activeReleaseRecord(store, organizationId)?.release;
  return Object.keys(release?.workflows ?? {}).sort().filter((id) => {
    const have = workflowAgentTools(store, organizationId, id) ?? [];
    return tools.every((tool) => have.includes(tool));
  });
}

/** The workspace's default way of working (ADR 0022), if the owner set one. */
export function wayOfWorking(store: Store, workspaceId: string): { workflowId: string; requiredTools: string[] } | undefined {
  const row = store.control.prepare("SELECT workflow_id, required_tools_json FROM workspace_way_of_working WHERE workspace_id=?").get(workspaceId) as { workflow_id: string; required_tools_json: string } | undefined;
  return row ? { workflowId: row.workflow_id, requiredTools: JSON.parse(row.required_tools_json) as string[] } : undefined;
}
