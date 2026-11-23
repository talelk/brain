import {
  BrainError, type ArtifactLink, type Attempt, type AttemptEvent, type AttemptFailure, type Check, type JsonValue, type Note, type PullRequest, type PlayFile, type SubtaskSummary, type Task, type TaskSummary, type ToolCall,
} from "@brain/contracts";
import type { Governor } from "../app";
import { tx, type Db } from "../db";
import { log } from "../log";
import type { Ctx } from "../dispatch";
import { append } from "../events";
import { inputProblem } from "../tools/schema";
import { approvalsWhere } from "../trust/approvals";
import { COST, spendOf, usageWhere } from "../trust/usage";
import { inputSchema } from "../workspace/load";
import { getWorkspace, manifestOf } from "../workspace/store";
import { HEAL } from "./heal";
import { queueOf, queuedOf, steerOf } from "./queue";
import { continueCheckpoint } from "./checkpoint";
import { personCheck, reviveTask, settle, startPlan, stopTask } from "./orchestrator";
import { createFromPlay, insertTask, json, needOf, setState, taskIn, taskOf, TERMINAL, type TaskRow } from "./store";

/** The commands a person steers work with and the queries of the Today, Tasks and Task screens (docs/architecture.md sections 4 and 10). */

// A goal's cost is that of its whole tree; a sub-task's is its own. `waiting_for_you` counts the tasks of the tree (itself included) that need a person.
const SUMMARY = `SELECT t.*, r.title AS goal_title, r.play AS root_play, u.name AS created_by_name,
  (SELECT f.title FROM tasks f WHERE t.created_by LIKE 'heal:%' AND f.id = substr(t.created_by, 6)) AS heals_title,
  (SELECT f.root_id FROM tasks f WHERE t.created_by LIKE 'heal:%' AND f.id = substr(t.created_by, 6)) AS heals_root,
  (SELECT json_patch(e.payload_json, json_object('at', e.created_at_ms)) FROM events e WHERE e.subject = 'task:' || t.id AND e.type = 'task.superseded' ORDER BY e.seq DESC LIMIT 1) AS superseded,
  CASE WHEN t.parent_id IS NULL THEN (SELECT COALESCE(SUM(${COST}), 0) FROM usage u JOIN tasks x ON x.id = u.task_id WHERE x.root_id = t.id)
  ELSE (SELECT COALESCE(SUM(${COST}), 0) FROM usage u WHERE u.task_id = t.id) END AS micro_usd,
  (WITH RECURSIVE tree(id) AS (SELECT t.id UNION ALL SELECT c.id FROM tasks c JOIN tree ON c.parent_id = tree.id) SELECT COUNT(*) FROM tasks x WHERE x.state = 'needs_you' AND x.id IN (SELECT id FROM tree)) AS waiting_for_you
  FROM tasks t JOIN tasks r ON r.id = t.root_id LEFT JOIN "user" u ON u.id = t.created_by`;
type SummaryRow = TaskRow & { readonly micro_usd: number; readonly goal_title: string; readonly root_play: string | null; readonly created_by_name: string | null; readonly waiting_for_you: number; readonly superseded: string | null; readonly heals_title: string | null; readonly heals_root: string | null };
const supersededOf = (text: string): NonNullable<TaskSummary["supersededBy"]> => {
  const event = JSON.parse(text) as { by: string; byRoot: string; byState: "done" | "check"; hours: number; at: number };
  return { taskId: event.by, rootId: event.byRoot, state: event.byState, hours: event.hours, at: event.at };
};
const summary = (row: SummaryRow): TaskSummary => ({
  id: row.id, workspaceId: row.workspace_id, parentId: row.parent_id, rootId: row.root_id, title: row.title, goalTitle: row.goal_title, agent: row.agent, state: row.state, needs: needOf(row),
  play: row.root_play, stepId: row.step_id, round: row.round, microUsd: row.micro_usd, createdAt: row.created_at_ms, updatedAt: row.updated_at_ms, finishedAt: row.finished_at_ms,
  ...(row.created_by_name !== null ? { createdByName: row.created_by_name } : {}), waitingForYou: row.waiting_for_you,
  ...(row.superseded !== null && row.state === "stopped" ? { supersededBy: supersededOf(row.superseded) } : {}),
  ...(row.heals_title !== null ? { heals: { id: row.created_by.slice(HEAL.length), rootId: row.heals_root as string, title: row.heals_title } } : {}),
});
export const summaries = (db: Db, where: string, ...values: unknown[]): TaskSummary[] => (db.prepare(`${SUMMARY} WHERE ${where}`).all(...values) as SummaryRow[]).map(summary);
const waitsFor = (db: Db, taskId: string): string[] => (db.prepare("SELECT waits_for FROM task_deps WHERE task_id=?").all(taskId) as Array<{ waits_for: string }>).map((dep) => dep.waits_for);

/** A task and everything under it, as a condition on a task id column. */
const TREE = "WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)";
/** `text` cut to `max` characters at a word, with an ellipsis, when it is longer. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
const titleOf = (goal: string): string => shorten((goal.split("\n").find((line) => line.trim() !== "") ?? goal).trim(), 80);
/** The title of a goal started from a Play: the Play's title and, when it has one, the start of its first text input. */
function playTitle(play: PlayFile, inputs: Readonly<Record<string, JsonValue>>): string {
  const first = Object.entries(play.inputs).filter(([, spec]) => spec.type === "string").map(([name]) => inputs[name]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  const line = (first ?? "").split("\n").find((text) => text.trim() !== "")?.trim().replace(/\s+/gu, " ") ?? "";
  return line === "" ? play.title : `${play.title}: ${shorten(line, 40)}`;
}
const like = (text: string): string => `%${text.replace(/[\\%_]/gu, "\\$&")}%`;
const notStarted = (db: Db, task: TaskRow): boolean => (task.state === "waiting" || task.state === "ready") && !db.prepare("SELECT 1 FROM attempts WHERE task_id=? LIMIT 1").get(task.id) && !db.prepare("SELECT 1 FROM tasks WHERE parent_id=? LIMIT 1").get(task.id);

function agentKnown(ctx: Ctx, parent: TaskRow, agent: string): void {
  if (!manifestOf(ctx.gov, parent.snapshot_digest).agents[agent]) throw new BrainError("INVALID_INPUT", `There is no agent ${agent}`, [{ path: "agent", message: "not an agent of the workspace as this task was created on it" }]);
}
/** Sets what a sub-task waits for: other sub-tasks of the same parent. That none waits for itself, through the others, is checked once the whole edit is made. */
function setAfter(db: Db, parent: TaskRow, taskId: string, after: readonly string[]): void {
  for (const id of after) {
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND parent_id=?").get(id, parent.id)) throw new BrainError("INVALID_INPUT", `${id} is not a sub-task of this task`, [{ path: "after", message: "names a task that is not a sub-task of the same task" }]);
  }
  db.prepare("DELETE FROM task_deps WHERE task_id=?").run(taskId);
  for (const id of after) db.prepare("INSERT INTO task_deps(task_id, waits_for) VALUES (?,?)").run(taskId, id);
}
function assertAcyclic(db: Db, parent: TaskRow): void {
  const children = db.prepare("SELECT id, title FROM tasks WHERE parent_id=?").all(parent.id) as Array<{ id: string; title: string }>;
  const settled = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (path.includes(id)) throw new BrainError("INVALID_INPUT", "Sub-tasks cannot wait for each other in a circle", [{ path: "after", message: `${children.find((child) => child.id === id)?.title ?? id} would wait for itself` }]);
    if (settled.has(id)) return;
    for (const next of waitsFor(db, id)) visit(next, [...path, id]);
    settled.add(id);
  };
  for (const child of children) visit(child.id, []);
}

export function registerTasks(governor: Governor): void {
  const { gov } = governor;
  const { registry } = gov;
  // Besides after every change, the orchestrator runs on a timer: a limit that was raised, or a day that began, lets waiting work start, and a wait for a person can reach the age at which a newer identical goal closes it.
  governor.every(15_000, () => {
    // One workspace at a time, each in its own transaction: one that cannot settle must not hold back the others.
    for (const { id } of gov.db.prepare("SELECT DISTINCT workspace_id AS id FROM tasks WHERE state IN ('waiting','ready','needs_you')").all() as Array<{ id: string }>) {
      try { tx(gov.db, () => settle(gov, id)); }
      catch (error) { log("error", "task.settle_failed", { workspaceId: id, error: String(error) }); }
    }
  });

  registry.command("task.create", (ctx, input) => {
    const workspace = getWorkspace(ctx.db, input.workspaceId);
    const createdBy = ctx.actor.id;
    let root: TaskRow;
    if (input.play !== undefined) {
      const play = manifestOf(ctx.gov, workspace.snapshotDigest).plays[input.play];
      if (!play) throw new BrainError("NOT_FOUND", `The workspace has no Play ${input.play}`);
      const problem = inputProblem(inputSchema(play.inputs), input.inputs as JsonValue);
      if (problem) throw new BrainError("INVALID_INPUT", `The inputs of ${input.play} are not valid: ${problem}`, [{ path: "inputs", message: problem }]);
      root = createFromPlay(ctx.gov, ctx.actor, { workspaceId: workspace.id, snapshotDigest: workspace.snapshotDigest, play: input.play, inputs: input.inputs as Record<string, JsonValue>, title: input.title ?? playTitle(play, input.inputs as Record<string, JsonValue>), goal: input.goal, createdBy });
    } else {
      const goal = input.goal as string;
      root = insertTask(ctx.gov, ctx.actor, { workspaceId: workspace.id, parent: null, snapshotDigest: workspace.snapshotDigest, title: input.title ?? titleOf(goal), goal, agent: null, state: "running", createdBy });
      startPlan(ctx.gov, root);
    }
    settle(ctx.gov, workspace.id);
    return { taskId: root.id };
  });

  registry.command("task.confirm", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (needOf(task)?.kind !== "confirm-plan") throw new BrainError("CONFLICT", "This task has no plan waiting to be confirmed");
    setState(ctx.gov, task, "running", {}, ctx.actor);
    settle(ctx.gov, input.workspaceId);
    return {};
  });

  registry.command("task.edit", (ctx, input) => {
    const { db } = ctx;
    const parent = taskIn(db, input.workspaceId, input.taskId);
    if (parent.agent !== null || TERMINAL.includes(parent.state)) throw new BrainError("CONFLICT", "Sub-tasks can be changed on a task that groups them and has not ended");
    const child = (id: string): TaskRow => {
      const row = db.prepare("SELECT * FROM tasks WHERE id=? AND parent_id=?").get(id, parent.id) as TaskRow | undefined;
      if (!row) throw new BrainError("NOT_FOUND", `${id} is not a sub-task of this task`);
      if (!notStarted(db, row)) throw new BrainError("CONFLICT", `"${row.title}" has already started`);
      return row;
    };
    // The changes are one edit, whatever their order: removals first, then changes and additions, and the result is checked as it stands.
    for (const change of input.changes) {
      if (change.op !== "remove") continue;
      const row = child(change.id);
      db.prepare("DELETE FROM tasks WHERE id=?").run(row.id);
      append(db, { type: "task.removed", workspaceId: parent.workspace_id, subject: `task:${row.id}`, payload: { title: row.title, parentId: parent.id }, actor: ctx.actor });
    }
    for (const change of input.changes) {
      if (change.op === "add") {
        agentKnown(ctx, parent, change.agent);
        const added = insertTask(ctx.gov, ctx.actor, { workspaceId: parent.workspace_id, parent, snapshotDigest: parent.snapshot_digest, title: change.title, goal: change.goal, agent: change.agent, state: "waiting", createdBy: ctx.actor.id });
        setAfter(db, parent, added.id, change.after);
      } else if (change.op === "change") {
        const row = child(change.id);
        if (change.agent !== undefined) agentKnown(ctx, parent, change.agent);
        if (change.after !== undefined) setAfter(db, parent, row.id, change.after);
        db.prepare("UPDATE tasks SET title=?, goal=?, agent=?, state='waiting', updated_at_ms=?, version=version+1 WHERE id=?").run(change.title ?? row.title, change.goal ?? row.goal, row.agent === null ? null : (change.agent ?? row.agent), ctx.now(), row.id);
        append(db, { type: "task.edited", workspaceId: parent.workspace_id, subject: `task:${row.id}`, payload: { title: change.title ?? null, agent: change.agent ?? null, after: change.after ?? null, goal: change.goal !== undefined }, actor: ctx.actor });
      }
    }
    assertAcyclic(db, parent);
    settle(ctx.gov, input.workspaceId);
    return {};
  });

  registry.command("task.stop", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (TERMINAL.includes(task.state)) throw new BrainError("CONFLICT", `This task is already ${task.state}`);
    stopTask(ctx.gov, task, ctx.actor);
    settle(ctx.gov, input.workspaceId);
    return {};
  });
  registry.command("task.checkpoint", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (needOf(task)?.kind !== "checkpoint") throw new BrainError("CONFLICT", "This task has no checkpoint waiting");
    continueCheckpoint(ctx.gov, taskOf(ctx.db, task.root_id), ctx.user?.name ?? "a person", input.goal);
    settle(ctx.gov, input.workspaceId);
    return {};
  });
  registry.command("task.steer", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (TERMINAL.includes(task.state)) throw new BrainError("CONFLICT", `This task is already ${task.state}`);
    const now = steerOf(ctx.db, task);
    // The task's own record: the priority it is to have and whether it waits; what the call leaves out stays as it is.
    append(ctx.db, { type: "task.steered", workspaceId: task.workspace_id, subject: `task:${task.id}`, payload: { priority: input.priority ?? now.priority, paused: input.paused ?? now.paused, title: task.title }, actor: ctx.actor });
    return {};
  });
  registry.command("workspace.stopAll", (ctx, input) => {
    const roots = ctx.db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND parent_id IS NULL AND state NOT IN ('done','failed','stopped')").all(input.workspaceId) as TaskRow[];
    for (const root of roots) stopTask(ctx.gov, root, ctx.actor);
    return { stopped: roots.length };
  });

  registry.command("task.retry", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (task.state !== "failed" && task.state !== "stopped" && needOf(task)?.kind !== "failed-subtask") throw new BrainError("CONFLICT", "Only a task that failed or was stopped, or whose sub-task did, can be tried again");
    reviveTask(ctx.gov, task, ctx.actor);
    settle(ctx.gov, input.workspaceId);
    return {};
  });

  registry.command("task.check", (ctx, input) => {
    personCheck(ctx.gov, taskIn(ctx.db, input.workspaceId, input.taskId), input, ctx.actor);
    settle(ctx.gov, input.workspaceId);
    return {};
  });

  registry.command("task.answer", (ctx, input) => {
    const task = taskIn(ctx.db, input.workspaceId, input.taskId);
    if (needOf(task)?.kind !== "answer") throw new BrainError("CONFLICT", "This task has no question waiting for an answer");
    // The answer is kept with the question the agent asked; the next attempt of the task is given both.
    ctx.db.prepare("UPDATE tool_calls SET output_json=? WHERE task_id=? AND tool='task.ask' AND json_extract(output_json, '$.status')='waiting'").run(JSON.stringify({ status: "answered", answer: input.answer, by: ctx.user?.name ?? "a person", at: ctx.now() }), task.id);
    append(ctx.db, { type: "task.answered", workspaceId: task.workspace_id, subject: `task:${task.id}`, payload: { answer: input.answer }, actor: ctx.actor });
    setState(ctx.gov, task, "ready", {}, ctx.actor);
    settle(ctx.gov, input.workspaceId);
    return {};
  });

  // --- queries ---

  registry.query("queue", (ctx, input) => {
    if (!ctx.user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    return queueOf(ctx.gov, ctx.user, input.workspaceId);
  });

  registry.query("today", (ctx, input) => ({
    needsYou: summaries(ctx.db, "t.workspace_id=? AND t.state='needs_you' ORDER BY t.updated_at_ms DESC LIMIT 100", input.workspaceId),
    running: summaries(ctx.db, "t.workspace_id=? AND t.parent_id IS NULL AND t.state IN ('waiting','ready','running') AND waiting_for_you = 0 ORDER BY t.created_at_ms DESC LIMIT 100", input.workspaceId),
    recent: summaries(ctx.db, "t.workspace_id=? AND t.parent_id IS NULL AND t.state IN ('done','failed','stopped') ORDER BY t.finished_at_ms DESC LIMIT 20", input.workspaceId),
    approvals: approvalsWhere(ctx.db, "a.workspace_id=? AND a.state='pending' ORDER BY a.created_at_ms", input.workspaceId),
    spend: spendOf(ctx.gov, input.workspaceId),
  }));

  registry.query("tasks.list", (ctx, input) => ({
    tasks: summaries(ctx.db, `t.workspace_id=? AND (? IS NULL OR t.parent_id=?) AND (? = 0 OR t.parent_id IS NULL) AND (? IS NULL OR CASE ? WHEN 'needs_you' THEN (t.state = 'needs_you' OR waiting_for_you > 0) WHEN 'running' THEN (t.state = 'running' AND waiting_for_you = 0) ELSE t.state = ? END) AND (? IS NULL OR t.created_at_ms<?)
      AND (? IS NULL OR t.title LIKE ? ESCAPE '\\' OR t.goal LIKE ? ESCAPE '\\') ORDER BY t.created_at_ms DESC, t.rowid DESC LIMIT ?`,
      input.workspaceId, input.parentId ?? null, input.parentId ?? null, input.rootsOnly ? 1 : 0, input.state ?? null, input.state ?? null, input.state ?? null, input.before ?? null, input.before ?? null,
      input.search ?? null, input.search === undefined ? null : like(input.search), input.search === undefined ? null : like(input.search), input.limit),
  }));

  registry.query("task.get", (ctx, input): Task => {
    const { db } = ctx;
    const row = db.prepare(`${SUMMARY} WHERE t.id=? AND t.workspace_id=?`).get(input.taskId, input.workspaceId) as SummaryRow | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "Task not found");
    const inTree = `IN (${TREE} SELECT id FROM tree)`;
    const { models } = manifestOf(ctx.gov, row.snapshot_digest);
    const attempts = (db.prepare(`SELECT a.*, r.name AS runner, u.model, u.input_tokens, u.output_tokens, u.cached_input_tokens, ${COST} AS micro_usd FROM attempts a LEFT JOIN runners r ON r.id = a.runner_id LEFT JOIN usage u ON u.attempt_id = a.id
      WHERE a.task_id ${inTree} ORDER BY a.rowid`).all(row.id) as Array<{ id: string; task_id: string; kind: Attempt["kind"]; agent: string; state: Attempt["state"]; round: number; runner: string | null; engine: string | null; model: string | null;
      result: string | null; failure_json: string | null; input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; micro_usd: number | null; created_at_ms: number; started_at_ms: number | null; finished_at_ms: number | null }>)
      .map((a): Attempt => ({
        priced: (a.micro_usd ?? 0) > 0 || (a.input_tokens ?? 0) + (a.output_tokens ?? 0) === 0 || models.some((model) => model.name === a.model && (model.input_usd_per_mtok ?? model.output_usd_per_mtok) !== undefined),
        id: a.id, taskId: a.task_id, kind: a.kind, agent: a.agent, state: a.state, round: a.round, runner: a.runner, engine: a.engine, model: a.model, result: a.result, failure: json<AttemptFailure>(a.failure_json),
        usage: { microUsd: a.micro_usd ?? 0, inputTokens: a.input_tokens ?? 0, outputTokens: a.output_tokens ?? 0, cachedInputTokens: a.cached_input_tokens ?? 0 }, createdAt: a.created_at_ms, startedAt: a.started_at_ms, finishedAt: a.finished_at_ms,
      }));
    const checks = (db.prepare(`SELECT c.*, u.name FROM checks c LEFT JOIN "user" u ON u.id = c.by_id AND c.by_kind='person' WHERE c.task_id ${inTree} ORDER BY c.id`).all(row.id) as
      Array<{ id: number; task_id: string; round: number; by_kind: "agent" | "person"; by_id: string; name: string | null; pass: number; score: number | null; findings: string; created_at_ms: number }>)
      .map((c): Check => ({ id: c.id, taskId: c.task_id, round: c.round, by: { kind: c.by_kind, id: c.by_id, name: c.name ?? c.by_id }, pass: c.pass === 1, score: c.score, findings: c.findings, at: c.created_at_ms }));
    const toolCalls = (db.prepare(`SELECT * FROM tool_calls WHERE task_id ${inTree} ORDER BY rowid`).all(row.id) as
      Array<{ id: string; attempt_id: string; tool: string; effect: ToolCall["effect"]; input_json: string; output_json: string | null; outcome: ToolCall["outcome"]; approval_id: string | null; created_at_ms: number }>)
      .map((c): ToolCall => ({ id: c.id, attemptId: c.attempt_id, tool: c.tool, effect: c.effect, input: JSON.parse(c.input_json) as JsonValue, output: json<JsonValue>(c.output_json), outcome: c.outcome, approvalId: c.approval_id, at: c.created_at_ms }));
    return {
      ...summary(row), goal: row.goal, result: row.result, output: json<JsonValue>(row.output_json), snapshotDigest: row.snapshot_digest, createdBy: row.created_by,
      waitsFor: waitsFor(db, row.id),
      steer: (({ priority, paused }) => ({ priority, paused }))(steerOf(db, row)), queued: queuedOf(ctx.gov, row.id),
      settings: { reviewBy: row.review_by, maxRounds: row.max_rounds, targetScore: row.target_score, approve: row.approve === 1, when: row.when_expr, candidates: json<number | string[]>(row.candidates_json), judge: row.judge },
      subtasks: (db.prepare(`${SUMMARY} WHERE t.id ${inTree} AND t.id != ? ORDER BY t.rowid`).all(row.id, row.id) as SummaryRow[]).map((sub): SubtaskSummary => ({ ...summary(sub), goal: sub.goal, waitsFor: waitsFor(db, sub.id) })),
      attempts, checks, toolCalls,
      approvals: approvalsWhere(db, `a.task_id ${inTree} ORDER BY a.rowid`, row.id),
      notes: db.prepare("SELECT n.id, COALESCE((SELECT task_id FROM attempts WHERE id = n.attempt_id), n.root_id) AS taskId, n.author, n.text, n.created_at_ms AS at FROM notes n WHERE n.root_id=? ORDER BY n.id").all(row.root_id) as Note[],
      artifacts: db.prepare(`SELECT l.digest, l.name, l.kind, l.media_type AS mediaType, a.bytes, l.attempt_id AS attemptId FROM artifact_links l JOIN artifacts a ON a.digest = l.digest WHERE l.task_id ${inTree} ORDER BY l.id`).all(row.id) as ArtifactLink[],
      pullRequests: db.prepare(`SELECT task_id AS taskId, project, branch, url, number, state, created_at_ms AS at FROM pull_requests WHERE task_id ${inTree} ORDER BY id`).all(row.id) as PullRequest[],
      usage: usageWhere(db, `u.task_id ${inTree}`, row.id), version: row.version,
      heal: (db.prepare("SELECT id AS taskId, state FROM tasks WHERE created_by=?").get(`${HEAL}${row.id}`) as { taskId: string; state: Task["state"] } | undefined) ?? null,
    };
  });

  registry.query("task.events", (ctx, input) => {
    taskIn(ctx.db, input.workspaceId, input.taskId);
    if (!ctx.db.prepare(`SELECT 1 FROM attempts WHERE id=? AND task_id IN (${TREE} SELECT id FROM tree)`).get(input.attemptId, input.taskId)) throw new BrainError("NOT_FOUND", "Attempt not found");
    const rows = ctx.db.prepare("SELECT seq, at_ms AS at, body_json FROM attempt_events WHERE attempt_id=? AND seq>? ORDER BY seq LIMIT ?").all(input.attemptId, input.after, input.limit) as Array<{ seq: number; at: number; body_json: string }>;
    return { events: rows.map((row) => ({ ...(JSON.parse(row.body_json) as object), seq: row.seq, at: row.at }) as AttemptEvent) };
  });
}
