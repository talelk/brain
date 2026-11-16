import {
  BrainError, type Actor, type AttemptFailure, type AttemptKind, type AttemptState, type Digest, type JsonValue, type SnapshotManifest, type StepSpec, type TaskNeed, type TaskState,
} from "@brain/contracts";
import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { manifestOf } from "../workspace/store";
import { renderGoal, type PlannedTask, type Scope, type StepSettings } from "./decide";

/** Tasks and attempts as rows, and the few writes every part of the work side shares. */
export interface TaskRow {
  readonly id: string; readonly workspace_id: string; readonly parent_id: string | null; readonly root_id: string; readonly position: number;
  readonly title: string; readonly goal: string; readonly agent: string | null; readonly state: TaskState; readonly snapshot_digest: Digest;
  readonly play: string | null; readonly inputs_json: string | null; readonly step_id: string | null; readonly item_index: number | null; readonly item_json: string | null;
  readonly for_each: string | null; readonly when_expr: string | null; readonly review_by: string | null; readonly max_rounds: number; readonly target_score: number | null;
  readonly approve: number; readonly candidates_json: string | null; readonly judge: string | null; readonly round: number;
  readonly result: string | null; readonly output_json: string | null; readonly needs_json: string | null; readonly created_by: string;
  readonly created_at_ms: number; readonly updated_at_ms: number; readonly started_at_ms: number | null; readonly finished_at_ms: number | null; readonly version: number;
}
export interface AttemptRow {
  readonly id: string; readonly workspace_id: string; readonly task_id: string; readonly kind: AttemptKind; readonly agent: string; readonly state: AttemptState;
  readonly round: number; readonly candidate: number | null; readonly runner_id: string | null; readonly engine: string | null;
  readonly fence: number; readonly offer_expires_at_ms: number | null; readonly lease_expires_at_ms: number | null; readonly tries: number; readonly available_at_ms: number;
  readonly payload_json: string; readonly result: string | null; readonly output_json: string | null; readonly failure_json: string | null;
  readonly receipt_json: string | null; readonly receipt_signature: string | null; readonly working_copy: Digest | null; readonly base_commits_json: string | null;
  readonly created_at_ms: number; readonly started_at_ms: number | null; readonly finished_at_ms: number | null;
}
/** What an attempt is given beyond its task: the attempts under check or judgement, or the approved call of an `act`. `offered` lists the stored bytes its offer named. */
export interface AttemptPayload {
  readonly review?: readonly string[];
  readonly act?: { readonly callId: string; readonly approvalId: string; readonly tool: string; readonly input: JsonValue };
  readonly offered?: readonly Digest[];
}

export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/gu, "x")}`;
/** The UTC day a moment falls on, `YYYY-MM-DD`: the day spend and standing approvals are counted by. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const TERMINAL: readonly TaskState[] = ["done", "failed", "stopped"];
export const ACTIVE_ATTEMPT = "('queued','offered','running')";
export const json = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

export function taskOf(db: Db, taskId: string): TaskRow {
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as TaskRow | undefined;
  if (!row) throw new BrainError("NOT_FOUND", "Task not found");
  return row;
}
/** A task of the workspace the caller named; one of another workspace does not exist for them. */
export function taskIn(db: Db, workspaceId: string, taskId: string): TaskRow {
  const row = db.prepare("SELECT * FROM tasks WHERE id=? AND workspace_id=?").get(taskId, workspaceId) as TaskRow | undefined;
  if (!row) throw new BrainError("NOT_FOUND", "Task not found");
  return row;
}
export function attemptOf(db: Db, attemptId: string): AttemptRow {
  const row = db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId) as AttemptRow | undefined;
  if (!row) throw new BrainError("NOT_FOUND", "Attempt not found");
  return row;
}
export const payloadOf = (attempt: AttemptRow): AttemptPayload => JSON.parse(attempt.payload_json) as AttemptPayload;
export const failureOf = (attempt: AttemptRow): AttemptFailure | null => json<AttemptFailure>(attempt.failure_json);
export const needOf = (task: TaskRow): TaskNeed | null => json<TaskNeed>(task.needs_json);

export function settingsOf(task: TaskRow): StepSettings {
  return {
    agent: task.agent, reviewBy: task.review_by, maxRounds: task.max_rounds, targetScore: task.target_score, approve: task.approve === 1,
    candidates: json<number | string[]>(task.candidates_json), judge: task.judge,
  };
}

/** The step of the Play a task was made from, as the task's snapshot holds it. */
export function stepOf(gov: Gov, task: TaskRow): StepSpec | undefined {
  if (task.step_id === null) return undefined;
  const root = task.id === task.root_id ? task : taskOf(gov.db, task.root_id);
  return root.play === null ? undefined : manifestOf(gov, task.snapshot_digest).plays[root.play]?.step.find((step) => step.id === task.step_id);
}

/** What the templates of a task's step can read: the inputs of its Play, the results of the Play's steps so far, and its own item. */
export function scopeOf(db: Db, task: TaskRow): Scope {
  const root = task.id === task.root_id ? task : taskOf(db, task.root_id);
  const steps: Record<string, { result: string; output: JsonValue | null }> = {};
  for (const row of db.prepare("SELECT step_id, result, output_json FROM tasks WHERE parent_id=? AND step_id IS NOT NULL AND state='done'").all(root.id) as Array<{ step_id: string; result: string | null; output_json: string | null }>) {
    steps[row.step_id] = { result: row.result ?? "", output: json<JsonValue>(row.output_json) };
  }
  const item = json<JsonValue>(task.item_json);
  return { inputs: json<Record<string, JsonValue>>(root.inputs_json) ?? {}, steps, ...(item === null ? {} : { item }) };
}

export interface NewTask {
  readonly workspaceId: string; readonly parent: TaskRow | null; readonly snapshotDigest: Digest; readonly title: string; readonly goal: string; readonly agent: string | null;
  readonly state: TaskState; readonly createdBy: string; readonly position?: number; readonly play?: string; readonly inputs?: Readonly<Record<string, JsonValue>>;
  readonly step?: StepSpec; readonly item?: { readonly index: number; readonly value: JsonValue }; readonly after?: readonly string[];
}
/** Inserts a task. A task made from a step carries the step's settings; the copies of a `for_each` step carry them instead of their group. */
export function insertTask(gov: Gov, actor: Actor, input: NewTask): TaskRow {
  const { db } = gov;
  const id = newId("t");
  const now = gov.clock.nowMs();
  const { step, parent } = input;
  const forEach = input.item === undefined ? step?.for_each : undefined;
  const group = forEach !== undefined;
  const position = input.position ?? (parent ? (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE parent_id=?").get(parent.id) as { next: number }).next : 0);
  db.prepare(`INSERT INTO tasks(id, workspace_id, parent_id, root_id, position, title, goal, agent, state, snapshot_digest, play, inputs_json, step_id, item_index, item_json, for_each, when_expr,
      review_by, max_rounds, target_score, approve, candidates_json, judge, created_by, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.workspaceId, parent?.id ?? null, parent?.root_id ?? id, position, input.title, input.goal, group ? null : input.agent, input.state, input.snapshotDigest,
    input.play ?? null, input.inputs ? JSON.stringify(input.inputs) : null, step?.id ?? null, input.item?.index ?? null, input.item ? JSON.stringify(input.item.value) : null,
    forEach ?? null, input.item === undefined ? (step?.when ?? null) : null,
    group ? null : (step?.review_by ?? null), step?.max_rounds ?? 2, group ? null : (step?.target_score ?? null), !group && step?.approve ? 1 : 0,
    !group && step?.candidates !== undefined ? JSON.stringify(step.candidates) : null, group ? null : (step?.judge ?? null), input.createdBy, now, now,
  );
  for (const waitsFor of input.after ?? []) db.prepare("INSERT OR IGNORE INTO task_deps(task_id, waits_for) VALUES (?,?)").run(id, waitsFor);
  append(db, { type: "task.created", workspaceId: input.workspaceId, subject: `task:${id}`, payload: { title: input.title, agent: input.agent, parentId: parent?.id ?? null, play: input.play ?? null, stepId: step?.id ?? null }, actor });
  return taskOf(db, id);
}

/** Moves a task to a state, with why it needs a person or what it resulted in, and records it. */
export function setState(gov: Gov, task: TaskRow, state: TaskState, change: { readonly need?: TaskNeed; readonly result?: string; readonly output?: JsonValue | null; readonly round?: number; readonly goal?: string } = {}, actor?: Actor): TaskRow {
  const now = gov.clock.nowMs();
  const need = state === "needs_you" ? (change.need ?? null) : null;
  gov.db.prepare(`UPDATE tasks SET state=?, needs_json=?, result=COALESCE(?, result), output_json=CASE WHEN ? THEN ? ELSE output_json END, round=?, goal=?, updated_at_ms=?,
      finished_at_ms=?, version=version+1 WHERE id=?`).run(
    state, need ? JSON.stringify(need) : null, change.result ?? null, change.result !== undefined ? 1 : 0, change.output === undefined || change.output === null ? null : JSON.stringify(change.output),
    change.round ?? task.round, change.goal ?? task.goal, now, TERMINAL.includes(state) ? now : null, task.id,
  );
  if (state !== task.state || (need !== null && JSON.stringify(need) !== task.needs_json)) {
    append(gov.db, {
      type: `task.${state}`, workspaceId: task.workspace_id, subject: `task:${task.id}`,
      payload: { from: task.state, title: task.title, root: task.parent_id === null, ...(need ? { need: need as unknown as JsonValue } : {}), ...(change.round !== undefined ? { round: change.round } : {}) },
      actor: actor ?? { kind: "system", id: "governor" },
    });
  }
  return taskOf(gov.db, task.id);
}

export interface NewAttempt { readonly task: TaskRow; readonly kind: AttemptKind; readonly agent: string; readonly candidate?: number | null; readonly payload?: AttemptPayload; readonly tries?: number; readonly delayMs?: number }
export function queueAttempt(gov: Gov, input: NewAttempt): string {
  const id = newId("a");
  const now = gov.clock.nowMs();
  const { task } = input;
  gov.db.prepare("INSERT INTO attempts(id, workspace_id, task_id, kind, agent, state, round, candidate, tries, available_at_ms, payload_json, created_at_ms) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?)")
    .run(id, task.workspace_id, task.id, input.kind, input.agent, task.round, input.candidate ?? null, input.tries ?? 0, now + (input.delayMs ?? 0), JSON.stringify(input.payload ?? {}), now);
  append(gov.db, { type: "attempt.queued", workspaceId: task.workspace_id, subject: `attempt:${id}`, payload: { taskId: task.id, kind: input.kind, agent: input.agent, round: task.round }, actor: { kind: "system", id: "governor" } });
  return id;
}

// --- a Play, or a plan, to tasks ---

/** The agents a snapshot holds. */
export const agentsOf = (manifest: SnapshotManifest): ReadonlySet<string> => new Set(Object.keys(manifest.agents));

/** The root task of a Play and one sub-task per step, each waiting for the steps it names in `after`. */
export function createFromPlay(gov: Gov, actor: Actor, input: { workspaceId: string; snapshotDigest: Digest; play: string; inputs: Readonly<Record<string, JsonValue>>; title?: string | undefined; goal?: string | undefined; createdBy: string }): TaskRow {
  const play = manifestOf(gov, input.snapshotDigest).plays[input.play];
  if (!play) throw new BrainError("NOT_FOUND", `The workspace has no Play ${input.play}`);
  const root = insertTask(gov, actor, {
    workspaceId: input.workspaceId, parent: null, snapshotDigest: input.snapshotDigest, title: input.title ?? play.title, goal: input.goal ?? (play.description || play.title), agent: null,
    state: "running", createdBy: input.createdBy, play: input.play, inputs: input.inputs,
  });
  const scope: Scope = { inputs: input.inputs, steps: {} };
  const byStep = new Map<string, string>();
  for (const [position, step] of play.step.entries()) {
    const agent = step.agent ?? (Array.isArray(step.candidates) ? (step.candidates[0] ?? null) : null);
    const task = insertTask(gov, actor, {
      workspaceId: input.workspaceId, parent: root, snapshotDigest: input.snapshotDigest, title: step.id, goal: renderGoal(step.goal ?? root.goal, scope, true), agent, state: "waiting",
      createdBy: input.createdBy, position, step, after: step.after.map((id) => byStep.get(id) as string),
    });
    byStep.set(step.id, task.id);
  }
  return root;
}

/** The sub-tasks a plan proposes, under the task that asked for the plan. `after` names titles of the same plan. */
export function createPlanned(gov: Gov, actor: Actor, parent: TaskRow, tasks: readonly PlannedTask[]): void {
  const byTitle = new Map<string, string>();
  for (const planned of tasks) {
    const task = insertTask(gov, actor, {
      workspaceId: parent.workspace_id, parent, snapshotDigest: parent.snapshot_digest, title: planned.title, goal: planned.goal, agent: planned.agent, state: "waiting",
      createdBy: parent.created_by, after: planned.after.map((title) => byTitle.get(title) as string),
    });
    byTitle.set(planned.title, task.id);
  }
}
