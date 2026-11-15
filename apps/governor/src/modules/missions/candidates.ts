import type { PlanCandidate, WorkItemCandidate, WorkItemCandidates } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { admitFanOut } from "./budget";
import { observedCalls } from "./outcomes";
import { taskOf } from "./outputs";
import { runUsage } from "./usage";

type Db = ReturnType<Store["workspaceDb"]>;
type LinkRow = { run_id: string; candidate_id: string; candidate_round: number; created_at_ms: number; finished_at_ms: number | null; run_state: string };

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled", "partial", "blocked"]);

/** Whether a workflow run has ended: nothing more of it will run. */
export const isTerminalRun = (state: string): boolean => TERMINAL_RUN.has(state);

/** The candidates a work item's plan task declares (ADR 0071); empty for an ordinary task. */
export function candidatesOf(db: Db, workItemId: string): readonly PlanCandidate[] {
  try { return taskOf(db, workItemId).task.candidates ?? []; } catch (cause) { if (cause instanceof BrainDomainError) return []; throw cause; }
}

/** The round of the latest fan-out of a work item: each start of its candidates is one round, and a keep belongs to one round. */
export function currentRound(db: Db, workItemId: string): number {
  return (db.prepare("SELECT COALESCE(MAX(candidate_round),0) AS n FROM execution_links WHERE work_item_id=?").get(workItemId) as { n: number }).n;
}

/** The candidate runs of the latest round, in the order the plan lists the candidates. */
export function roundLinks(db: Db, workItemId: string): LinkRow[] {
  return db.prepare(`SELECT l.run_id, l.candidate_id, l.candidate_round, l.created_at_ms, l.finished_at_ms, r.state AS run_state FROM execution_links l
    JOIN workflow_runs r ON r.id=l.run_id WHERE l.work_item_id=? AND l.candidate_round=(SELECT MAX(candidate_round) FROM execution_links WHERE work_item_id=?) ORDER BY l.created_at_ms, l.rowid`).all(workItemId, workItemId) as LinkRow[];
}

/** The member a candidate run acts as: the candidate's own member, else the one the task is assigned to; null when neither. */
export function candidateMember(db: Db, workItemId: string, candidateId: string): string | null | undefined {
  const candidate = candidatesOf(db, workItemId).find((entry) => entry.id === candidateId);
  return candidate?.memberId ?? undefined;
}

/**
 * Whether a succeeded candidate run counts as a result: when the task needs tools, the run must have recorded one successful call of
 * them (ADR 0022), the same rule a lone attempt answers to. A run that observed nothing is a failed candidate, not a result.
 */
export function candidateObserved(store: Store, db: Db, workItemId: string, runId: string): boolean {
  const needed = JSON.parse((db.prepare("SELECT required_tools_json AS j FROM work_items WHERE id=?").get(workItemId) as { j: string }).j) as string[];
  return needed.length === 0 || observedCalls(store, db, workItemId, needed, runId).succeeded > 0;
}

/**
 * Starts the next round of a task's candidates: refused while the previous round still runs, or when the mission's limits do not cover
 * every candidate before the first one starts (ADR 0071). Returns the round number and the candidates to start. A replayed dispatch
 * (its first run already exists) reuses its round and is never admitted twice.
 */
export function beginRound(store: Store, db: Db, item: { id: string; mission_id: string }, replayedRunId?: string): { round: number; candidates: readonly PlanCandidate[] } | undefined {
  const candidates = candidatesOf(db, item.id);
  if (candidates.length === 0) return undefined;
  if (replayedRunId) {
    const link = db.prepare("SELECT candidate_round AS round FROM execution_links WHERE work_item_id=? AND run_id=?").get(item.id, replayedRunId) as { round: number | null } | undefined;
    if (link?.round) return { round: link.round, candidates };
  }
  if (roundLinks(db, item.id).some((link) => !TERMINAL_RUN.has(link.run_state))) throw new BrainDomainError("CONFLICT", "this task's candidates are already running");
  const cost = (() => { try { return taskOf(db, item.id).task.maxMicroUsd ?? 0; } catch { return 0; } })();
  const admitted = admitFanOut(store, db, item.mission_id, candidates.length, cost);
  if (!admitted.admitted) throw new BrainDomainError("CONFLICT", `The ${candidates.length} candidates cannot start together: ${admitted.why}`);
  // A new round starts without a kept candidate; the earlier round's versions stay as compared outputs.
  db.prepare("UPDATE work_items SET kept_run_id=NULL, kept_by=NULL, kept_at_ms=NULL WHERE id=? AND kept_run_id IS NOT NULL").run(item.id);
  return { round: currentRound(db, item.id) + 1, candidates };
}

const labelOf = (candidate: PlanCandidate): string => [candidate.memberId, candidate.workflowId].filter((part): part is string => Boolean(part)).join(" on ");

/** The verdict of a run, as its own evaluator step recorded it: verified, not verified, or still pending. */
function verdictOf(db: Db, runId: string, runState: string): WorkItemCandidate["verdict"] {
  const bundles = db.prepare("SELECT digest, state FROM evidence_bundles WHERE json_extract(manifest_json,'$.workflowRunId')=?").all(runId) as Array<{ digest: string; state: string }>;
  if (bundles.some((bundle) => db.prepare("SELECT 1 FROM verification_verdicts WHERE bundle_digest=? AND outcome='verified'").get(bundle.digest))) return "verified";
  if (!TERMINAL_RUN.has(runState)) return "pending";
  const undecided = bundles.some((bundle) => bundle.state === "assembling" || bundle.state === "submitted") && runState === "succeeded";
  return undecided ? "pending" : "not-verified";
}

/**
 * The candidates of a work item as people see them side by side: who ran each, its state, its own verdict, the output version it produced,
 * what it cost and how long it took. When exactly one succeeded candidate is verified and the mission's autonomy is not supervised, Brain
 * proposes it; a person still keeps it (ADR 0071).
 */
export function candidatesView(store: Store, db: Db, workspaceId: string, item: { id: string; kept_run_id: string | null; kept_by: string | null; kept_at_ms: number | null }, preset: string | undefined): WorkItemCandidates | undefined {
  const defs = candidatesOf(db, item.id);
  const links = roundLinks(db, item.id);
  if (defs.length === 0 || links.length === 0) return undefined;
  const now = store.now();
  const items: WorkItemCandidate[] = links.map((link) => {
    const def = defs.find((entry) => entry.id === link.candidate_id);
    const attempts = (store.control.prepare("SELECT COUNT(*) AS n FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=?").get(link.run_id) as { n: number }).n;
    const observed = link.run_state !== "succeeded" || candidateObserved(store, db, item.id, link.run_id);
    const state: WorkItemCandidate["state"] = link.run_state === "succeeded" ? (observed ? "succeeded" : "failed") : link.run_state === "cancelled" ? "cancelled" : TERMINAL_RUN.has(link.run_state) ? "failed" : attempts > 0 ? "running" : "waiting";
    const usage = runUsage(store, db, workspaceId, link.run_id).usage;
    const version = db.prepare("SELECT id, output_id FROM output_versions WHERE work_item_id=? AND run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(item.id, link.run_id) as { id: string; output_id: string } | undefined;
    const end = link.finished_at_ms ?? (TERMINAL_RUN.has(link.run_state) ? undefined : now);
    return {
      candidateId: link.candidate_id, runId: link.run_id,
      ...(def?.memberId ? { memberId: def.memberId } : {}), ...(def?.workflowId ? { workflowId: def.workflowId } : {}),
      label: def ? labelOf(def) : link.candidate_id, state,
      verdict: state === "failed" || state === "cancelled" ? "not-verified" : verdictOf(db, link.run_id, link.run_state),
      ...(version ? { outputId: version.output_id, outputVersionId: version.id } : {}),
      settledMicroUsd: usage.settledMicroUsd, reservedMicroUsd: usage.reservedMicroUsd, tokensUsed: usage.settledTokens + usage.reservedTokens,
      ...(end !== undefined ? { durationMs: Math.max(0, end - link.created_at_ms) } : {}),
      ...(item.kept_run_id === link.run_id ? { kept: true as const } : {}),
    };
  });
  const verified = items.filter((entry) => entry.state === "succeeded" && entry.verdict === "verified");
  const proposable = !item.kept_run_id && verified.length === 1 && preset !== "supervised" && !items.some((entry) => entry.state === "waiting" || entry.state === "running");
  const proposed = proposable ? verified[0]!.runId : undefined;
  return {
    round: links[0]!.candidate_round, items: items.map((entry) => entry.runId === proposed ? { ...entry, proposed: true as const } : entry),
    ...(item.kept_run_id ? { keptRunId: item.kept_run_id, ...(item.kept_by ? { keptBy: item.kept_by } : {}), ...(item.kept_at_ms ? { keptAt: iso(item.kept_at_ms) } : {}) } : {}),
  };
}
