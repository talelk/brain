import type { Actor, TaskNeed } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { manifestOf } from "../workspace/store";
import { HEAL } from "./heal";
import { ACTIVE_ATTEMPT, json, needOf, taskOf, TERMINAL, type TaskRow } from "./store";

/**
 * A goal that waits for a person is closed when a newer identical one has a result (docs/model.md, "When a newer identical task made a
 * waiting one useless"). Closing is `stopped`, with a `task.superseded` event on every task it stops.
 */
const HOUR_MS = 3_600_000;
const SUPERSEDABLE: ReadonlySet<TaskNeed["kind"]> = new Set(["check", "answer", "approval", "confirm-plan", "failed-subtask"]);

/** JSON with its keys in order, so two values are equal when their text is. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const sameGoal = (a: TaskRow, b: TaskRow): boolean =>
  a.play === b.play && (a.play === null ? a.goal === b.goal : canonical(json(a.inputs_json) ?? {}) === canonical(json(b.inputs_json) ?? {}));

interface Match { readonly id: string; readonly rootId: string; readonly state: "done" | "check" }

/** The newer task of an identical goal that corresponds to `target` and has a result: done, or waiting for a check. */
function newerMatch(gov: Gov, target: TaskRow): Match | undefined {
  const { db } = gov;
  const rid = (db.prepare("SELECT rowid AS rid FROM tasks WHERE id=?").get(target.id) as { rid: number }).rid;
  const root = taskOf(db, target.root_id);
  const isRoot = target.parent_id === null;
  const candidates = db.prepare(`SELECT * FROM tasks WHERE workspace_id=? AND rowid > ? AND root_id != ? AND (parent_id IS NULL) = ?
    AND (? OR (title = ? AND agent IS ? AND step_id IS ? AND item_index IS ? AND (step_id IS NOT NULL OR goal = ?)))
    AND (state = 'done' OR (state = 'needs_you' AND json_extract(needs_json, '$.kind') = 'check')) ORDER BY rowid`)
    .all(target.workspace_id, rid, target.root_id, isRoot ? 1 : 0, isRoot ? 1 : 0, target.title, target.agent, target.step_id, target.item_index, target.goal) as TaskRow[];
  for (const candidate of candidates) {
    if (healFor(candidate) || !sameGoal(root, taskOf(db, candidate.root_id))) continue;
    return { id: candidate.id, rootId: candidate.root_id, state: candidate.state === "done" ? "done" : "check" };
  }
  return undefined;
}
const healFor = (task: TaskRow): boolean => task.created_by.startsWith(HEAL);

/** Closes every goal of a workspace that has waited long enough for a person and was superseded. Returns how many it closed. */
export function closeSuperseded(gov: Gov, workspaceId: string, stopTask: (gov: Gov, task: TaskRow, actor: Actor) => number): number {
  const { db } = gov;
  const now = gov.clock.nowMs();
  const waiting = db.prepare("SELECT DISTINCT root_id FROM tasks WHERE workspace_id=? AND state='needs_you' AND updated_at_ms <= ?").all(workspaceId, now - HOUR_MS) as Array<{ root_id: string }>;
  if (waiting.length === 0) return 0;
  const active = (db.prepare("SELECT active_snapshot AS digest FROM workspaces WHERE id=?").get(workspaceId) as { digest: string }).digest;
  const hours = manifestOf(gov, active).cleanup.superseded_after_hours;
  if (hours === 0) return 0;
  let closed = 0;
  for (const { root_id } of waiting) {
    const tree = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id) SELECT t.* FROM tasks t JOIN tree ON tree.id = t.id ORDER BY t.rowid`).all(root_id) as TaskRow[];
    const open = tree.filter((task) => !TERMINAL.includes(task.state));
    if (open.length === 0 || open.some((task) => task.agent !== null && (task.state === "ready" || task.state === "running"))) continue;
    if (open.some((task) => db.prepare(`SELECT 1 FROM attempts WHERE task_id=? AND state IN ${ACTIVE_ATTEMPT}`).get(task.id))) continue;
    // Every task that waits for a person must be of a kind a newer identical result answers, waited long enough, and have that result.
    let reason: Match | undefined;
    let waited = Infinity;
    let all = true;
    for (const task of open.filter((one) => one.state === "needs_you")) {
      const need = needOf(task);
      const target = need?.kind === "failed-subtask" ? tree.find((one) => one.id === need.taskId) : task;
      const found = need && SUPERSEDABLE.has(need.kind) && now - task.updated_at_ms >= hours * HOUR_MS && target ? newerMatch(gov, target) : undefined;
      if (!found) { all = false; break; }
      reason ??= found;
      waited = Math.min(waited, now - task.updated_at_ms);
    }
    if (!all || !reason) continue;
    const payload = { by: reason.id, byRoot: reason.rootId, byState: reason.state, hours: Math.floor(waited / HOUR_MS) };
    // The heal goals of the tree's tasks, failed ones included, end with it.
    const heals = tree.flatMap((task) => db.prepare("SELECT * FROM tasks WHERE created_by=? AND parent_id IS NULL AND state NOT IN ('done','failed','stopped')").all(`${HEAL}${task.id}`) as TaskRow[]);
    for (const goal of [taskOf(db, root_id), ...heals]) {
      const stopping = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id) SELECT t.id, t.title FROM tasks t JOIN tree ON tree.id = t.id WHERE t.state NOT IN ('done','failed','stopped') ORDER BY t.rowid`).all(goal.id) as Array<{ id: string; title: string }>;
      stopTask(gov, goal, SYSTEM);
      for (const task of stopping) append(db, { type: "task.superseded", workspaceId, subject: `task:${task.id}`, payload: { title: task.title, ...payload }, actor: SYSTEM });
    }
    closed += 1;
  }
  return closed;
}
