import type { PlanTask } from "@brain/contracts";
import type { Store } from "../../application/store";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;

/** The portable regression case (`brain.eval-case/v1`). It holds the stored plan, the findings and pinned deliverable digests; never transcripts, notes or messages. */
export interface EvalCase {
  readonly format: "brain.eval-case/v1";
  readonly caseId: string;
  readonly kind: "rejected-verdict" | "task-sent-back";
  readonly workspaceId: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly intent: string;
  readonly successCriteria: readonly string[];
  readonly tasks: ReadonlyArray<{ id: string; title: string; criteria: readonly string[] }>;
  readonly findings: readonly string[];
  readonly deliverableDigests: readonly string[];
  readonly recordedAt: string;
}

const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text;

/**
 * Saves one regression case for a rejected sign-off or a re-opened result (issue #64, ADR 0010). It runs inside the
 * transition's transaction and is idempotent per triggering event (`source`). It only stores: nothing here changes a prompt,
 * a workflow or a release; a case is read back by the release-time quality run.
 */
export function recordEvalCase(store: Store, db: Db, input: { workspaceId: string; source: string; kind: EvalCase["kind"]; missionId: string; workItemId?: string; findings: readonly string[] }): void {
  if (db.prepare("SELECT 1 FROM eval_cases WHERE source=?").get(input.source)) return;
  const mission = db.prepare("SELECT title, intent, success_criteria_json, active_plan_version_id FROM missions WHERE id=?").get(input.missionId) as { title: string; intent: string; success_criteria_json: string; active_plan_version_id: string | null } | undefined;
  if (!mission) return;
  const plan = mission.active_plan_version_id ? db.prepare("SELECT tasks_json FROM plan_versions WHERE id=?").get(mission.active_plan_version_id) as { tasks_json: string } | undefined : undefined;
  let tasks = (plan ? JSON.parse(plan.tasks_json) as PlanTask[] : []);
  if (input.workItemId) {
    const taskId = (db.prepare("SELECT plan_task_id FROM work_items WHERE id=?").get(input.workItemId) as { plan_task_id: string } | undefined)?.plan_task_id;
    tasks = tasks.filter((task) => task.id === taskId);
  }
  const digests = (db.prepare("SELECT DISTINCT v.artifact_digest AS digest FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE o.mission_id=? AND v.state='final' ORDER BY v.created_at_ms LIMIT 20").all(input.missionId) as Array<{ digest: string }>).map((row) => row.digest);
  const id = store.id("evalcase");
  const now = store.now();
  const body: EvalCase = {
    format: "brain.eval-case/v1", caseId: id, kind: input.kind, workspaceId: input.workspaceId, missionId: input.missionId,
    missionTitle: cut(mission.title, 256), intent: cut(mission.intent, 4000), successCriteria: (JSON.parse(mission.success_criteria_json) as string[]).map((entry) => cut(String(entry), 500)),
    tasks: tasks.map((task) => ({ id: task.id, title: cut(task.title, 256), criteria: task.criteria.map((entry) => cut(entry, 500)) })),
    findings: input.findings.slice(0, 20).map((entry) => cut(entry, 1000)), deliverableDigests: digests, recordedAt: iso(now),
  };
  db.prepare("INSERT INTO eval_cases(id,source,kind,mission_id,work_item_id,case_json,created_at_ms) VALUES (?,?,?,?,?,?,?)").run(id, input.source, input.kind, input.missionId, input.workItemId ?? null, JSON.stringify(body), now);
}

export function listEvalCases(db: Db, limit: number): { items: EvalCase[]; total: number } {
  const rows = db.prepare("SELECT case_json FROM eval_cases ORDER BY created_at_ms DESC, id LIMIT ?").all(limit) as Array<{ case_json: string }>;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM eval_cases").get() as { n: number }).n;
  return { items: rows.map((row) => JSON.parse(row.case_json) as EvalCase), total };
}
