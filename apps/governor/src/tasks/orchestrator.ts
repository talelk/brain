import { ATTEMPT_COMPLETED_EVENT, BrainError, type Actor, type AttemptFailure, type JsonValue, type TaskNeed } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { expireApprovals } from "../trust/approvals";
import { settleUsage } from "../trust/usage";
import { manifestOf } from "../workspace/store";
import { healFailed } from "./heal";
import { afterCheck, afterPersonCheck, afterWork, checkerOf, doers, groupOutcome, promote, readJudgement, readPlan, readVerdict, passes, renderGoal, retryOf, SKIPPED, type WorkFacts, type WorkState } from "./decide";
import {
  ACTIVE_ATTEMPT, agentsOf, attemptOf, createPlanned, failureOf, insertTask, json, needOf, payloadOf, queueAttempt, scopeOf, setState, settingsOf, stepOf, taskOf, TERMINAL,
  type AttemptRow, type TaskRow,
} from "./store";

/**
 * The orchestrator (docs/architecture.md section 5): it reads the facts, asks `decide.ts` what follows, and writes that. `settle` runs
 * inside the transaction of every change to a workspace's work, and on a timer; `attemptEnded` runs when an attempt reaches its end.
 */

const undone = "SELECT 1 FROM task_deps d JOIN tasks t ON t.id = d.waits_for WHERE d.task_id=? AND t.state != 'done' LIMIT 1";
const brokenChild = "SELECT id FROM tasks WHERE parent_id=? AND state IN ('failed','stopped') ORDER BY position LIMIT 1";
const activeAttempts = (gov: Gov, taskId: string, kind?: string): number =>
  (gov.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND state IN ${ACTIVE_ATTEMPT} AND (? IS NULL OR kind=?)`).get(taskId, kind ?? null, kind ?? null) as { n: number }).n;

/** A waiting task: needs a person when a sub-task of it broke, and moves on once everything it waits for is done. True when it changed. */
function advanceWaiting(gov: Gov, task: TaskRow): boolean {
  const { db } = gov;
  if (task.parent_id !== null) {
    const parent = taskOf(db, task.parent_id);
    if (TERMINAL.includes(parent.state) || needOf(parent)?.kind === "confirm-plan") return false;
  }
  const broken = db.prepare(brokenChild).get(task.id) as { id: string } | undefined;
  if (broken) {
    setState(gov, task, "needs_you", { need: { kind: "failed-subtask", taskId: broken.id } });
    return true;
  }
  if (db.prepare(undone).get(task.id)) return false;
  const step = stepOf(gov, task);
  const scope = scopeOf(db, task);
  const next = promote({ agent: task.agent, when: task.when_expr, forEach: task.for_each }, scope);
  if (next.to === "skipped") setState(gov, task, "done", { result: SKIPPED });
  // A goal still as its Play wrote it gets the results it names filled in; one a person rewrote keeps their words.
  else if (next.to === "ready") setState(gov, task, "ready", step?.goal !== undefined && renderGoal(step.goal, scope, true) === task.goal ? { goal: renderGoal(step.goal, scope) } : {});
  else if (next.to === "running") setState(gov, task, "running");
  else {
    // One copy per item, each waiting for what the step waits for, so it is given the same results and working-copy changes.
    const after = (db.prepare("SELECT waits_for FROM task_deps WHERE task_id=?").all(task.id) as Array<{ waits_for: string }>).map((row) => row.waits_for);
    if (!step) throw new Error(`task ${task.id} has for_each but no step`);
    for (const [index, value] of next.items.entries()) {
      const named = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { readonly [key: string]: JsonValue })["title"] : undefined;
      insertTask(gov, SYSTEM, {
        workspaceId: task.workspace_id, parent: task, snapshotDigest: task.snapshot_digest, title: typeof named === "string" && named.trim() !== "" ? named.slice(0, 200) : `${step.id} ${index + 1}`,
        goal: renderGoal(step.goal ?? task.goal, { ...scope, item: value }), agent: step.agent ?? null, state: "waiting", createdBy: task.created_by, position: index, step, item: { index, value }, after,
      });
    }
    setState(gov, task, "running");
  }
  return true;
}

/** A task that groups sub-tasks follows them; a task whose own sub-task broke comes back once it is retried or removed. True when it changed. */
function followSubtasks(gov: Gov, task: TaskRow): boolean {
  const need = needOf(task);
  if (task.state === "needs_you" && need?.kind !== "failed-subtask") return false;
  if (task.agent !== null) {
    if (task.state !== "needs_you" || gov.db.prepare(brokenChild).get(task.id)) return false;
    setState(gov, task, "waiting");
    return true;
  }
  const children = gov.db.prepare("SELECT id, state, result FROM tasks WHERE parent_id=? ORDER BY position").all(task.id) as Array<{ id: string; state: TaskRow["state"]; result: string | null }>;
  if (children.length === 0 && activeAttempts(gov, task.id) > 0) return false;
  const outcome = groupOutcome(children, task.for_each !== null);
  if (outcome.state === "done") setState(gov, task, "done", { result: outcome.result });
  else if (outcome.state === "needs_you" && (need?.kind !== "failed-subtask" || need.taskId !== outcome.need.taskId)) setState(gov, task, "needs_you", { need: outcome.need });
  else if (outcome.state === "running" && task.state === "needs_you") setState(gov, task, "running");
  else return false;
  return true;
}

/** Queues the work of ready tasks, oldest first, while the workspace is under its `running_tasks`. */
function startReady(gov: Gov, workspaceId: string, ready: readonly TaskRow[]): void {
  if (ready.length === 0) return;
  const limit = manifestOf(gov, (gov.db.prepare("SELECT active_snapshot AS digest FROM workspaces WHERE id=?").get(workspaceId) as { digest: string }).digest).limits.running_tasks;
  let busy = (gov.db.prepare(`SELECT COUNT(DISTINCT task_id) AS n FROM attempts WHERE workspace_id=? AND kind='work' AND state IN ${ACTIVE_ATTEMPT}`).get(workspaceId) as { n: number }).n;
  for (const task of ready) {
    if (activeAttempts(gov, task.id) > 0) continue;
    if (limit > 0 && busy >= limit) return;
    const settings = settingsOf(task);
    for (const [index, agent] of doers(settings).entries()) queueAttempt(gov, { task, kind: "work", agent, candidate: settings.candidates === null ? null : index });
    busy += 1;
  }
}

/** Brings a workspace's tasks to rest: promotes what can start, makes the copies of `for_each` steps, follows sub-tasks up to their parents, and queues work. */
export function settle(gov: Gov, workspaceId: string): void {
  const open = (): TaskRow[] => gov.db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND state IN ('waiting','ready','running','needs_you') ORDER BY rowid").all(workspaceId) as TaskRow[];
  for (let pass = 0; pass < 10_000; pass += 1) {
    let changed = false;
    // Sub-tasks are older than what waits for them and younger than their parent: deepest first lets one pass carry a result all the way up.
    for (const { id } of open().reverse()) {
      const task = taskOf(gov.db, id);
      if (task.state === "waiting") changed = advanceWaiting(gov, task) || changed;
      else if (task.state === "needs_you" || (task.state === "running" && task.agent === null)) changed = followSubtasks(gov, task) || changed;
    }
    if (!changed) break;
  }
  startReady(gov, workspaceId, open().filter((task) => task.state === "ready" && task.agent !== null));
}

// --- when an attempt ends ---

const needsPerson = (gov: Gov, task: TaskRow, why: TaskNeed): void => void setState(gov, task, "needs_you", { need: why });

/** The latest work attempt of the round, per candidate, and what the task's own calls left open. */
function workFacts(gov: Gov, task: TaskRow): { facts: WorkFacts; latest: AttemptRow[] } {
  const { db } = gov;
  const byCandidate = new Map<number, AttemptRow>();
  for (const attempt of db.prepare("SELECT * FROM attempts WHERE task_id=? AND kind='work' AND round=? ORDER BY rowid").all(task.id, task.round) as AttemptRow[]) byCandidate.set(attempt.candidate ?? 0, attempt);
  const latest = [...byCandidate.values()];
  const state = (attempt: AttemptRow): WorkState => (attempt.state === "queued" || attempt.state === "offered" || attempt.state === "running" ? "active" : attempt.state);
  const question = db.prepare("SELECT json_extract(input_json, '$.question') AS question FROM tool_calls WHERE task_id=? AND tool='task.ask' AND json_extract(output_json, '$.status')='waiting' ORDER BY rowid DESC LIMIT 1").get(task.id) as { question: string } | undefined;
  const pending = db.prepare("SELECT id FROM approvals WHERE task_id=? AND state='pending' ORDER BY rowid LIMIT 1").get(task.id) as { id: string } | undefined;
  return {
    latest,
    facts: {
      attempts: latest.map((attempt) => ({ id: attempt.id, state: state(attempt), detail: failureOf(attempt)?.detail ?? "" })),
      question: question?.question ?? null, openSubtasks: db.prepare(undone).get(task.id) !== undefined, pendingApproval: pending?.id ?? null, acting: activeAttempts(gov, task.id, "act") > 0,
    },
  };
}

/** A checked result: done, or a person's sign-off first. */
function passed(gov: Gov, task: TaskRow): void {
  if (task.approve === 1) needsPerson(gov, task, { kind: "sign-off" });
  else setState(gov, task, "done");
}

function recordCheck(gov: Gov, task: TaskRow, check: { by: { kind: "agent" | "person"; id: string }; attemptId: string | null; pass: boolean; score: number | null; findings: string }, actor: Actor): void {
  gov.db.prepare("INSERT INTO checks(task_id, round, by_kind, by_id, attempt_id, pass, score, findings, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(task.id, task.round, check.by.kind, check.by.id, check.attemptId, check.pass ? 1 : 0, check.score, check.findings, gov.clock.nowMs());
  append(gov.db, { type: "task.checked", workspaceId: task.workspace_id, subject: `task:${task.id}`, payload: { round: task.round, by: check.by, attemptId: check.attemptId, pass: check.pass, score: check.score }, actor });
}

/** Takes an attempt's result as the task's and has it checked by something other than the agent that produced it. */
function check(gov: Gov, task: TaskRow, work: AttemptRow): void {
  const settings = settingsOf(task);
  const held = setState(gov, task, "running", { result: work.result ?? "", output: json<JsonValue>(work.output_json) });
  // Of several candidates a judge already kept this one; that judgement is its check unless the step also names a reviewer.
  if (settings.candidates !== null && settings.reviewBy === null) return passed(gov, held);
  const by = checkerOf(settings, work.agent, agentsOf(manifestOf(gov, task.snapshot_digest)));
  if (by === null) needsPerson(gov, held, { kind: "check", findings: "" });
  else queueAttempt(gov, { task: held, kind: "check", agent: by, payload: { review: [work.id] } });
}

function afterWorkEnded(gov: Gov, task: TaskRow): void {
  const { facts, latest } = workFacts(gov, task);
  const decision = afterWork(settingsOf(task), facts);
  if (decision.next === "wait") return;
  if (decision.next === "needs") needsPerson(gov, task, decision.need);
  else if (decision.next === "subtasks") setState(gov, task, "waiting");
  else if (decision.next === "again") setState(gov, task, "ready");
  else if (decision.next === "failed") setState(gov, task, "failed", { result: decision.detail });
  else if (decision.next === "judge") queueAttempt(gov, { task: setState(gov, task, "running"), kind: "judge", agent: decision.by, payload: { review: decision.attemptIds } });
  else check(gov, task, latest.find((attempt) => attempt.id === decision.attemptId) as AttemptRow);
}

function afterCheckEnded(gov: Gov, task: TaskRow, attempt: AttemptRow): void {
  const verdict = attempt.state === "succeeded" ? readVerdict(attempt.result ?? "", json<JsonValue>(attempt.output_json)) : undefined;
  if (!verdict) {
    return needsPerson(gov, task, { kind: "check", findings: attempt.state === "succeeded" ? "The checker's answer could not be read as {pass, score, findings}." : `The check did not run: ${failureOf(attempt)?.detail ?? attempt.state}` });
  }
  const pass = passes(verdict, task.target_score);
  recordCheck(gov, task, { by: { kind: "agent", id: attempt.agent }, attemptId: payloadOf(attempt).review?.[0] ?? null, pass, score: verdict.score, findings: verdict.findings }, { kind: "agent", id: attempt.agent, attemptId: attempt.id });
  const decision = afterCheck({ ...settingsOf(task), round: task.round }, verdict);
  if (decision.next === "done") setState(gov, task, "done");
  else if (decision.next === "needs") needsPerson(gov, task, decision.need);
  else setState(gov, task, "ready", { round: decision.round });
}

function afterJudgeEnded(gov: Gov, task: TaskRow, attempt: AttemptRow): void {
  const attemptIds = payloadOf(attempt).review ?? [];
  const judgement = attempt.state === "succeeded" ? readJudgement(attempt.result ?? "", json<JsonValue>(attempt.output_json), attemptIds) : undefined;
  if (!judgement) return needsPerson(gov, task, { kind: "judge", attemptIds });
  recordCheck(gov, task, { by: { kind: "agent", id: attempt.agent }, attemptId: judgement.keep, pass: true, score: null, findings: judgement.findings }, { kind: "agent", id: attempt.agent, attemptId: attempt.id });
  check(gov, task, attemptOf(gov.db, judgement.keep));
}

function afterPlanEnded(gov: Gov, task: TaskRow, attempt: AttemptRow): void {
  if (attempt.state !== "succeeded") return void setState(gov, task, "failed", { result: `The plan could not be made: ${failureOf(attempt)?.detail ?? attempt.state}` });
  const manifest = manifestOf(gov, task.snapshot_digest);
  const plan = readPlan(attempt.result ?? "", json<JsonValue>(attempt.output_json), agentsOf(manifest));
  if ("problem" in plan) return void setState(gov, task, "failed", { result: `The plan could not be used: ${plan.problem}` });
  createPlanned(gov, { kind: "agent", id: attempt.agent, attemptId: attempt.id }, task, plan.tasks);
  if (plan.summary !== "") gov.db.prepare("INSERT INTO notes(workspace_id, root_id, author, attempt_id, text, created_at_ms) VALUES (?,?,?,?,?,?)").run(task.workspace_id, task.root_id, attempt.agent, attempt.id, `Plan: ${plan.summary}`, gov.clock.nowMs());
  if (manifest.limits.confirm_plans === "auto") setState(gov, task, "running");
  else needsPerson(gov, task, { kind: "confirm-plan" });
}

/** Called in the transaction that gave an attempt its final state: retries an infrastructure failure, or moves the task on. */
export function attemptEnded(gov: Gov, attemptId: string): void {
  const attempt = attemptOf(gov.db, attemptId);
  const task = taskOf(gov.db, attempt.task_id);
  if (!TERMINAL.includes(task.state)) {
    // An approved call is never repeated on its own: whether it happened is not known.
    const retry = attempt.state === "failed" && attempt.kind !== "act" ? retryOf(failureOf(attempt), attempt.tries) : { retry: false as const };
    if (retry.retry) {
      queueAttempt(gov, { task, kind: attempt.kind, agent: attempt.agent, candidate: attempt.candidate, payload: { ...payloadOf(attempt), offered: [] }, tries: retry.tries, delayMs: retry.delayMs });
      if (attempt.kind === "work") setState(gov, task, "ready");
    } else if (attempt.kind === "work" || attempt.kind === "act") afterWorkEnded(gov, task);
    else if (attempt.kind === "check") afterCheckEnded(gov, task, attempt);
    else if (attempt.kind === "judge") afterJudgeEnded(gov, task, attempt);
    else afterPlanEnded(gov, task, attempt);
    // A task that has just failed, with no attempt left, is looked into.
    const ended = taskOf(gov.db, task.id);
    if (ended.state === "failed") healFailed(gov, ended);
  }
  settle(gov, attempt.workspace_id);
}

/** Ends an attempt from the Governor's side (its runner is gone, or its task was stopped), with no receipt. */
export function closeAttempt(gov: Gov, attempt: AttemptRow, state: "failed" | "stopped", failure: AttemptFailure): void {
  const now = gov.clock.nowMs();
  gov.db.prepare("UPDATE attempts SET state=?, failure_json=?, finished_at_ms=?, lease_expires_at_ms=NULL, offer_expires_at_ms=NULL WHERE id=?").run(state, JSON.stringify(failure), now, attempt.id);
  settleUsage(gov, attempt.id);
  expireApprovals(gov, { attemptId: attempt.id }, failure.detail);
  append(gov.db, { type: ATTEMPT_COMPLETED_EVENT, workspaceId: attempt.workspace_id, subject: `attempt:${attempt.id}`, payload: { taskId: attempt.task_id, outcome: state, failure: failure as unknown as JsonValue }, actor: SYSTEM });
}

// --- what a person does to a task ---

/** Stops a task and everything under it: its attempts end, its pending approvals expire. Returns how many tasks stopped. */
export function stopTask(gov: Gov, task: TaskRow, actor: Actor): number {
  const { db } = gov;
  const tree = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
    SELECT t.* FROM tasks t JOIN tree ON tree.id = t.id WHERE t.state NOT IN ('done','failed','stopped')`).all(task.id) as TaskRow[];
  for (const open of tree) {
    for (const attempt of db.prepare(`SELECT * FROM attempts WHERE task_id=? AND state IN ${ACTIVE_ATTEMPT}`).all(open.id) as AttemptRow[]) {
      closeAttempt(gov, attempt, "stopped", { reason: "stopped", detail: "The task was stopped", infrastructure: false });
    }
    expireApprovals(gov, { taskId: open.id }, "The task was stopped");
    setState(gov, open, "stopped", {}, actor);
  }
  return tree.length;
}

/** Brings a failed or stopped task back: its own work is queued again, and so is that of every sub-task that failed or stopped with it. */
export function reviveTask(gov: Gov, task: TaskRow, actor: Actor): void {
  const children = gov.db.prepare("SELECT * FROM tasks WHERE parent_id=? ORDER BY position").all(task.id) as TaskRow[];
  for (const child of children) if (child.state === "failed" || child.state === "stopped") reviveTask(gov, child, actor);
  if (task.state !== "failed" && task.state !== "stopped") return;
  if (task.agent !== null || (task.for_each !== null && children.length === 0)) setState(gov, task, "waiting", {}, actor);
  else if (children.length > 0) setState(gov, task, "running", {}, actor);
  else startPlan(gov, setState(gov, task, "running", {}, actor));
}

/** Queues the planner for a goal given without a Play. */
export function startPlan(gov: Gov, root: TaskRow): void {
  if (!manifestOf(gov, root.snapshot_digest).agents["planner"]) throw new BrainError("CONFLICT", "This workspace has no planner agent: start a Play, or add the base pack");
  queueAttempt(gov, { task: root, kind: "plan", agent: "planner" });
}

/** A person's check, sign-off or choice among candidates. */
export function personCheck(gov: Gov, task: TaskRow, input: { pass: boolean; findings: string; keep?: string | undefined }, actor: Actor): void {
  const decision = afterPersonCheck({ round: task.round, needs: needOf(task) }, input);
  if ("refused" in decision) throw new BrainError("CONFLICT", decision.refused);
  const kept = decision.next === "done" && decision.attemptId !== undefined ? attemptOf(gov.db, decision.attemptId) : undefined;
  const checked = kept?.id ?? (gov.db.prepare("SELECT attempt_id AS id FROM checks WHERE task_id=? AND round=? ORDER BY id DESC LIMIT 1").get(task.id, task.round) as { id: string | null } | undefined)?.id
    ?? workFacts(gov, task).latest.find((attempt) => attempt.state === "succeeded")?.id ?? null;
  recordCheck(gov, task, { by: { kind: "person", id: actor.id }, attemptId: checked, pass: input.pass, score: null, findings: input.findings }, actor);
  if (decision.next === "again") setState(gov, task, "ready", { round: decision.round }, actor);
  else setState(gov, task, "done", kept ? { result: kept.result ?? "", output: json<JsonValue>(kept.output_json) } : {}, actor);
}
