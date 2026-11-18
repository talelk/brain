import { BrainError, PRIORITIES, roleAtLeast, type AttemptKind, type Priority, type Queue, type QueueItem, type QueueAction, type QueueRun, type QueueRunner, type Role, type User, type Wait } from "@brain/contracts";
import { accessOf, visibleWorkspaces } from "../access";
import { listRunners } from "../attempts/runners";
import { missing } from "../attempts/offer";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { COST, microUsd, overCap, spentToday } from "../trust/usage";
import { activeManifest, manifestOf } from "../workspace/store";
import { taskOf, type AttemptRow, type TaskRow } from "./store";

/**
 * The queue (docs/model.md, "The queue"): the one order in which queued attempts start, the reasons they have not, and what a person sees of it.
 * `dispatchOrder` and `blockOf` are what `claim` uses; `queueOf` shows the same order, so the screen is never a guess.
 */

export interface Steer { readonly priority: Priority; readonly paused: boolean; /** The place of the task's own steer in the audit chain; 0 for none. Of two `high` tasks the later goes first. */ readonly at: number }
const NONE: Steer = { priority: "normal", paused: false, at: 0 };
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/** A task's own priority and pause: its latest `task.steered` event. */
function own(db: Db, taskId: string): Steer | undefined {
  const row = db.prepare("SELECT payload_json AS payload, seq AS at FROM events WHERE subject=? AND type='task.steered' ORDER BY seq DESC LIMIT 1").get(`task:${taskId}`) as { payload: string; at: number } | undefined;
  if (!row) return undefined;
  const value = JSON.parse(row.payload) as { priority: Priority; paused: boolean };
  return { priority: PRIORITIES.includes(value.priority) ? value.priority : "normal", paused: value.paused === true, at: row.at };
}

/** A task's priority is its own, else its nearest ancestor's; it is paused when it or any ancestor is. */
export function steerOf(db: Db, task: Pick<TaskRow, "id" | "parent_id">, cache = new Map<string, Steer>()): Steer {
  const known = cache.get(task.id);
  if (known) return known;
  const mine = own(db, task.id);
  const above = task.parent_id === null ? NONE : steerOf(db, taskOf(db, task.parent_id), cache);
  const steer: Steer = { priority: mine?.priority ?? above.priority, paused: (mine?.paused ?? false) || above.paused, at: mine?.at ?? above.at };
  cache.set(task.id, steer);
  return steer;
}

export interface Entry { readonly attempt: AttemptRow; readonly task: TaskRow; readonly steer: Steer }

/**
 * Every queued attempt of an active workspace in the order the Governor starts them: priority first; within a priority the workspaces take turns (an attempt's turn is
 * the number of tasks its workspace already has running, then its place among its own queued attempts, oldest first); then age, and for `high` the task promoted last first.
 */
export function dispatchOrder(gov: Gov): Entry[] {
  const { db } = gov;
  const queued = db.prepare("SELECT a.* FROM attempts a JOIN workspaces w ON w.id = a.workspace_id WHERE a.state='queued' AND w.status='active' ORDER BY a.created_at_ms, a.rowid LIMIT 5000").all() as AttemptRow[];
  const running = runningTasks(gov);
  const cache = new Map<string, Steer>();
  // Within a priority and a workspace: oldest first, and of the `high` ones the task promoted last.
  const within = queued.map((attempt) => ({ attempt, task: taskOf(db, attempt.task_id) })).map(({ attempt, task }) => ({ attempt, task, steer: steerOf(db, task, cache) }))
    .sort((a, b) => RANK[a.steer.priority] - RANK[b.steer.priority] || (a.steer.priority === "high" ? b.steer.at - a.steer.at : 0) || a.attempt.created_at_ms - b.attempt.created_at_ms);
  const turns = new Map<string, number>();
  return within.map((entry, place) => {
    const group = `${entry.steer.priority}:${entry.attempt.workspace_id}`;
    const turn = (running.get(entry.attempt.workspace_id)?.size ?? 0) + (turns.get(group) ?? 0);
    turns.set(group, (turns.get(group) ?? 0) + 1);
    return { entry, turn, place };
  }).sort((a, b) => RANK[a.entry.steer.priority] - RANK[b.entry.steer.priority] || a.turn - b.turn || a.place - b.place).map(({ entry }) => entry);
}

/** The tasks of each workspace that an attempt is offered to or running for: "tasks running" of `running_tasks`. */
function runningTasks(gov: Gov): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of gov.db.prepare("SELECT workspace_id AS ws, task_id AS task FROM attempts WHERE state IN ('offered','running')").all() as Array<{ ws: string; task: string }>) {
    out.set(row.ws, (out.get(row.ws) ?? new Set()).add(row.task));
  }
  return out;
}

/** What `blockOf` keeps while it looks down the order: the tasks running per workspace (those that would start count too), and the cost of the day. */
export interface Standing { readonly now: number; readonly running: Map<string, Set<string>> }
export const standing = (gov: Gov): Standing => ({ now: gov.clock.nowMs(), running: runningTasks(gov) });

/** Why an attempt may not start whatever the runner: a pause, its retry backoff, its workspace's `running_tasks` or daily cap. Null when it may. */
export function blockOf(gov: Gov, entry: Entry, at: Standing): Wait | null {
  const { attempt, task, steer } = entry;
  const manifest = activeManifest(gov, attempt.workspace_id);
  // A snapshot made before `paused` existed has none.
  if ((manifest.limits as { paused?: boolean }).paused === true) return { kind: "paused-workspace" };
  if (steer.paused) return { kind: "paused-task" };
  if (attempt.available_at_ms > at.now) return { kind: "backoff", until: attempt.available_at_ms, tries: attempt.tries };
  const held = at.running.get(attempt.workspace_id) ?? new Set<string>();
  const limit = manifest.limits.running_tasks;
  if (limit > 0 && !held.has(task.id) && held.size >= limit) return { kind: "running-tasks", used: held.size, limit };
  const agent = manifestOf(gov, task.snapshot_digest).agents[attempt.agent];
  const reserve = microUsd(agent?.limits.spend_usd ?? 0);
  if (overCap(gov, attempt.workspace_id, manifest, reserve)) {
    return { kind: "daily-cap", spentMicroUsd: spentToday(gov, attempt.workspace_id), capMicroUsd: microUsd(manifest.limits.daily_spend_usd) };
  }
  return null;
}

// --- what a person sees ---

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const SAMPLES = 3;

interface Placed { readonly entry: Entry; readonly wait: Wait; readonly rank: number | null; readonly startsAt: number | null }

/** The queue as the dispatcher sees it, whoever asks: every queued attempt with its wait, rank and estimated start, and the runners. */
function placed(gov: Gov): { readonly items: Placed[]; readonly runners: ReturnType<typeof listRunners> } {
  const { db } = gov;
  const at = standing(gov);
  const runners = listRunners(gov);
  const online = runners.filter((runner) => runner.online);
  const free = online.reduce((sum, runner) => sum + runner.freeSlots, 0);
  const slots = online.reduce((sum, runner) => sum + runner.slots, 0);
  const durations = new Map<AttemptKind, number[]>();
  for (const row of db.prepare("SELECT kind, finished_at_ms - started_at_ms AS ms FROM attempts WHERE state='succeeded' AND started_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL ORDER BY finished_at_ms DESC LIMIT 200").all() as Array<{ kind: AttemptKind; ms: number }>) {
    durations.set(row.kind, [...(durations.get(row.kind) ?? []), row.ms]);
  }
  const ranked: Placed[] = [];
  const held: Placed[] = [];
  let ahead = 0;
  for (const entry of dispatchOrder(gov)) {
    const blocked = blockOf(gov, entry, at);
    if (blocked?.kind === "paused-workspace" || blocked?.kind === "paused-task" || blocked?.kind === "backoff") { held.push({ entry, wait: blocked, rank: null, startsAt: null }); continue; }
    const manifest = manifestOf(gov, entry.task.snapshot_digest);
    const lacks = online.map((runner) => missing(manifest, entry.attempt, { capabilities: new Set(runner.capabilities), engines: new Set(runner.engines) }));
    const wait: Wait = blocked ?? (online.length === 0 ? { kind: "no-runner" } : lacks.every((what) => what !== null) ? { kind: "capability", what: (lacks[0] as NonNullable<(typeof lacks)[0]>).what, missing: (lacks[0] as NonNullable<(typeof lacks)[0]>).name } : { kind: "slot", ahead });
    let startsAt: number | null = null;
    if (wait.kind === "slot") {
      const sample = durations.get(entry.attempt.kind) ?? [];
      if (ahead >= free && sample.length >= SAMPLES && slots > 0) startsAt = at.now + Math.ceil((ahead + 1 - free) / slots) * median(sample);
      // It will start; it takes a place in its workspace's running tasks, and a slot, for those behind it.
      at.running.set(entry.attempt.workspace_id, (at.running.get(entry.attempt.workspace_id) ?? new Set<string>()).add(entry.task.id));
      ahead += 1;
    }
    ranked.push({ entry, wait, rank: ranked.length + 1, startsAt });
  }
  return { items: [...ranked, ...held], runners };
}

/** The wait of a task, or of the sub-task of its tree that is first in line, when something under it is queued; null when nothing is. */
export function queuedOf(gov: Gov, taskId: string): { taskId: string; title: string; wait: Wait; rank: number | null; startsAt: number | null } | null {
  const tree = new Set((gov.db.prepare("WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id) SELECT id FROM tree").all(taskId) as Array<{ id: string }>).map((row) => row.id));
  const found = placed(gov).items.filter((item) => tree.has(item.entry.task.id)).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
  return found ? { taskId: found.entry.task.id, title: found.entry.task.title, wait: found.wait, rank: found.rank, startsAt: found.startsAt } : null;
}

/** The queue for a person: every workspace they see (an instance admin sees all of them), or one. */
/** The last few things an attempt did, as short labels (a tool or call named, the first words it said), for the Live screen. */
function doingOf(db: Db, attemptId: string): QueueAction[] {
  const rows = db.prepare("SELECT kind, body_json AS body, at_ms AS at FROM attempt_events WHERE attempt_id = ? AND kind IN ('tool.call','native.call','text','status') ORDER BY seq DESC LIMIT 12").all(attemptId) as Array<{ kind: string; body: string; at: number }>;
  const out: QueueAction[] = [];
  for (const row of rows) {
    const body = JSON.parse(row.body) as { tool?: string; name?: string; text?: string; channel?: string; detail?: string };
    if (row.kind === "tool.call" && body.tool) out.push({ kind: "tool", label: body.tool, at: row.at });
    else if (row.kind === "native.call" && body.name) out.push({ kind: "native", label: body.name, at: row.at });
    else if (row.kind === "text" && body.channel === "assistant" && body.text?.trim()) out.push({ kind: "text", label: body.text.trim().replace(/\s+/gu, " ").slice(0, 140), at: row.at });
    else if (row.kind === "status" && body.detail) out.push({ kind: "status", label: body.detail.slice(0, 80), at: row.at });
    if (out.length === 5) break;
  }
  return out.reverse();
}

export function queueOf(gov: Gov, user: User, only?: string): Queue {
  const { db } = gov;
  const now = gov.clock.nowMs();
  const mine = new Map<string, { id: string; slug: string; name: string; role: Role }>();
  if (user.instanceAdmin) {
    for (const row of db.prepare("SELECT id, slug, name FROM workspaces WHERE status='active'").all() as Array<{ id: string; slug: string; name: string }>) mine.set(row.id, { ...row, role: "viewer" });
  }
  for (const workspace of visibleWorkspaces(gov, user.id)) if (workspace.status === "active") mine.set(workspace.id, { id: workspace.id, slug: workspace.slug, name: workspace.name, role: workspace.role });
  if (only !== undefined && !accessOf(gov, user.id, only)) throw new BrainError("NOT_FOUND", "Workspace not found");
  const seen = (workspaceId: string): { id: string; slug: string; name: string; role: Role } | undefined => (only === undefined || only === workspaceId ? mine.get(workspaceId) : undefined);

  const { items, runners } = placed(gov);
  const titles = db.prepare("SELECT r.title AS goal FROM tasks r WHERE r.id=?");
  const item = (placedItem: Placed, workspace: { id: string; slug: string; name: string; role: Role }): QueueItem => {
    const { entry } = placedItem;
    return {
      taskId: entry.task.id, rootId: entry.task.root_id, title: entry.task.title, goalTitle: (titles.get(entry.task.root_id) as { goal: string }).goal, workspaceId: workspace.id, workspaceSlug: workspace.slug, workspaceName: workspace.name,
      agent: entry.attempt.agent, kind: entry.attempt.kind, priority: entry.steer.priority, paused: entry.steer.paused, rank: placedItem.rank, since: entry.attempt.created_at_ms, wait: placedItem.wait, startsAt: placedItem.startsAt,
      canSteer: roleAtLeast(workspace.role, "member"),
    };
  };
  const waiting: QueueItem[] = [];
  let hidden = 0;
  for (const placedItem of items) {
    const workspace = seen(placedItem.entry.attempt.workspace_id);
    if (workspace) waiting.push(item(placedItem, workspace));
    else if (only === undefined) hidden += 1;
  }

  const blocked: QueueItem[] = [];
  for (const row of db.prepare(`SELECT t.*, (SELECT d.waits_for FROM task_deps d JOIN tasks w ON w.id = d.waits_for WHERE d.task_id = t.id AND w.state != 'done' ORDER BY w.rowid LIMIT 1) AS blocker
    FROM tasks t JOIN tasks r ON r.id = t.root_id WHERE t.state='waiting' AND t.agent IS NOT NULL AND r.state NOT IN ('done','failed','stopped') AND blocker IS NOT NULL ORDER BY t.created_at_ms LIMIT 300`).all() as Array<TaskRow & { blocker: string }>) {
    const workspace = seen(row.workspace_id);
    if (!workspace || blocked.length >= 100) continue;
    const steer = steerOf(db, row);
    blocked.push({
      taskId: row.id, rootId: row.root_id, title: row.title, goalTitle: (titles.get(row.root_id) as { goal: string }).goal, workspaceId: workspace.id, workspaceSlug: workspace.slug, workspaceName: workspace.name, agent: row.agent, kind: "work",
      priority: steer.priority, paused: steer.paused, rank: null, since: row.created_at_ms, wait: { kind: "task", taskId: row.blocker, title: taskOf(db, row.blocker).title }, startsAt: null, canSteer: roleAtLeast(workspace.role, "member"),
    });
  }

  const lanes = new Map<string, { runs: QueueRun[]; hidden: number }>();
  let running = 0;
  for (const row of db.prepare(`SELECT a.*, t.title, t.root_id, (SELECT r.title FROM tasks r WHERE r.id = t.root_id) AS goal_title, COALESCE(u.input_tokens + u.output_tokens, 0) AS tokens, COALESCE(${COST}, 0) AS micro FROM attempts a JOIN tasks t ON t.id = a.task_id LEFT JOIN usage u ON u.attempt_id = a.id
    WHERE a.state IN ('offered','running') AND a.runner_id IS NOT NULL ORDER BY a.started_at_ms, a.rowid`).all() as Array<AttemptRow & { title: string; root_id: string; goal_title: string; tokens: number; micro: number }>) {
    const lane = lanes.get(row.runner_id as string) ?? { runs: [], hidden: 0 };
    lanes.set(row.runner_id as string, lane);
    const workspace = seen(row.workspace_id);
    if (!workspace) { lane.hidden += 1; continue; }
    running += 1;
    lane.runs.push({ doing: doingOf(db, row.id), attemptId: row.id, taskId: row.task_id, rootId: row.root_id, title: row.title, goalTitle: row.goal_title, agent: row.agent, kind: row.kind, workspaceSlug: workspace.slug, workspaceName: workspace.name, startedAt: row.started_at_ms, tokens: row.tokens, microUsd: row.micro });
  }
  const lane = (id: string) => lanes.get(id) ?? { runs: [] as QueueRun[], hidden: 0 };
  const shownRunners: QueueRunner[] = runners.map((runner) => ({
    id: runner.id, name: runner.name, online: runner.online, slots: runner.slots, freeSlots: runner.freeSlots,
    engines: user.instanceAdmin ? runner.engines : [], capabilities: user.instanceAdmin ? runner.capabilities : [], occupied: lane(runner.id).runs, hiddenOccupied: lane(runner.id).hidden,
  }));
  const paused = [...mine.values()].filter((workspace) => seen(workspace.id) && (activeManifest(gov, workspace.id).limits as { paused?: boolean }).paused === true).map(({ id, slug, name }) => ({ id, slug, name }));
  return { now, runners: shownRunners, waiting, blocked, hidden, running, paused, admin: user.instanceAdmin };
}
