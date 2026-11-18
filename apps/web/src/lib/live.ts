import type { Overview, Queue, TaskSummary } from "@brain/contracts";

/**
 * The shaping behind the Live screen: pure functions over what the Overview, the Queue and `tasks.list` already answer.
 * Nothing here reads the clock or the page; the screen passes `now`.
 */

export const HOUR = 3_600_000;

/** The stages of the flow, left to right. Failed branches off Running. */
export const STAGES = ["queued", "running", "checking", "needs", "done", "failed"] as const;
export type Stage = (typeof STAGES)[number];
export type StageCounts = Readonly<Record<Stage, number>>;

/** A task of a workspace with the workspace it belongs to. */
export interface Placed { readonly task: TaskSummary; readonly slug: string; readonly name: string }

/**
 * How many are at each stage: Queued and Running are what the Queue says now (a check running is counted under Checking, not Running),
 * Needs you is what waits for a person, Done and Failed are the tasks of the last hour that ended (goals themselves are not counted twice).
 */
export function stageCounts(queue: Queue | undefined, overview: Overview | undefined, tasks: readonly Placed[], now: number): StageCounts {
  const runs = (queue?.runners ?? []).flatMap((runner) => runner.occupied);
  const checking = runs.filter((run) => run.kind === "check").length;
  const running = Math.max(0, (queue?.running ?? runs.length) - checking);
  const since = now - HOUR;
  const ended = (state: "done" | "failed"): number => tasks.filter(({ task }) => task.parentId !== null && task.state === state && (task.finishedAt ?? task.updatedAt) >= since).length;
  return {
    queued: (queue?.waiting.length ?? 0) + (queue?.blocked.length ?? 0),
    running,
    checking,
    needs: (overview?.workspaces ?? []).reduce((sum, workspace) => sum + workspace.needsYou, 0),
    done: ended("done"),
    failed: ended("failed"),
  };
}

export interface FlowLink { readonly from: Stage; readonly to: Stage; readonly value: number }

/**
 * The ribbons between stages. A ribbon is as wide as what reached the stage it ends in, so a stage nothing reached has no ribbon:
 * Queued -> Running carries everything that started, Running -> Checking, Needs you, Done and Failed carry what each became.
 */
export function flowLinks(counts: StageCounts): readonly FlowLink[] {
  const started = counts.running + counts.checking + counts.needs + counts.done + counts.failed;
  const links: FlowLink[] = [
    { from: "queued", to: "running", value: started },
    { from: "running", to: "checking", value: counts.checking },
    { from: "running", to: "needs", value: counts.needs },
    { from: "running", to: "done", value: counts.done },
    { from: "running", to: "failed", value: counts.failed },
  ];
  return links.filter((link) => link.value > 0);
}

/** A ribbon's thickness in pixels: the square root keeps one large stage from flattening the rest, with a floor so a single task stays visible. */
export const ribbonWidth = (value: number, largest: number, max: number): number => (value <= 0 ? 0 : Math.max(2, max * Math.sqrt(value / Math.max(1, largest))));

export type FeedKind = "goal-done" | "goal-failed" | "goal-started" | "task-done" | "task-failed" | "task-started" | "task-stopped" | "approval" | "check-failed" | "question" | "plan" | "sign-off" | "judge" | "failed-subtask";

export interface FeedEvent {
  readonly id: string;
  readonly at: number;
  readonly kind: FeedKind;
  readonly slug: string;
  readonly workspace: string;
  readonly agent: string | null;
  readonly taskId: string;
  readonly rootId: string;
  readonly goalTitle: string;
  readonly title: string;
}

/** What a task's state means as an event; null for a task that merely waits. */
function kindOf(task: TaskSummary): FeedKind | null {
  const goal = task.parentId === null;
  switch (task.state) {
    case "done": return goal ? "goal-done" : "task-done";
    case "failed": return goal ? "goal-failed" : "task-failed";
    case "stopped": return "task-stopped";
    case "running": return goal ? "goal-started" : "task-started";
    case "needs_you":
      switch (task.needs?.kind) {
        case "approval": return "approval";
        case "check": return "check-failed";
        case "answer": return "question";
        case "confirm-plan": return "plan";
        case "sign-off": return "sign-off";
        case "judge": return "judge";
        case "failed-subtask": return "failed-subtask";
        default: return null;
      }
    default: return null;
  }
}

/** One event per task that did something, at the moment it did it. A goal whose sub-task needs the person is left to the sub-task. */
export function feedEvents(tasks: readonly Placed[]): FeedEvent[] {
  const events: FeedEvent[] = [];
  for (const { task, slug, name } of tasks) {
    const kind = kindOf(task);
    if (kind === null) continue;
    if (task.parentId === null && task.state === "needs_you") continue;
    events.push({ id: `${task.id}:${task.state}`, at: task.finishedAt ?? task.updatedAt, kind, slug, workspace: name, agent: task.agent, taskId: task.id, rootId: task.rootId, goalTitle: task.goalTitle, title: task.title });
  }
  return events.sort((a, b) => b.at - a.at);
}

export interface FeedGroup extends FeedEvent {
  /** How many equal events this line stands for (this one included). */
  readonly count: number;
  /** When the earliest of them happened. */
  readonly since: number;
}

/**
 * The feed as it is read: newest first; events of the same kind, workspace, agent, goal and title that follow each other
 * within `gapMs` become one line with a count, and the same event seen twice (same id) once. At most `limit` lines.
 */
export function groupFeed(events: readonly FeedEvent[], limit = 40, gapMs = 10 * 60_000): FeedGroup[] {
  const seen = new Set<string>();
  const groups: FeedGroup[] = [];
  const open = new Map<string, number>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const key = `${event.kind}|${event.slug}|${event.agent ?? ""}|${event.goalTitle}|${event.title}`;
    const index = open.get(key);
    const last = index === undefined ? undefined : groups[index];
    if (index !== undefined && last && last.since - event.at <= gapMs) { groups[index] = { ...last, count: last.count + 1, since: event.at }; continue; }
    open.set(key, groups.length);
    groups.push({ ...event, count: 1, since: event.at });
    if (groups.length >= limit * 4) break;
  }
  return groups.slice(0, limit);
}

/** Events per bucket over the last `buckets * size` ms, oldest first: the small area under the flow. */
export function activityBuckets(events: readonly FeedEvent[], now: number, buckets = 12, size = 5 * 60_000): number[] {
  const out = Array.from({ length: buckets }, () => 0);
  for (const event of events) {
    const age = now - event.at;
    if (age < 0 || age >= buckets * size) continue;
    const index = buckets - 1 - Math.floor(age / size);
    out[index] = (out[index] ?? 0) + 1;
  }
  return out;
}

export type Samples = ReadonlyMap<string, readonly number[]>;

/** The token counts seen so far for each running attempt, at most `keep` each, oldest first; an attempt no longer running is forgotten. */
export function pushSamples(before: Samples, runs: ReadonlyArray<{ readonly attemptId: string; readonly tokens: number }>, keep = 24): Samples {
  const next = new Map<string, readonly number[]>();
  for (const run of runs) {
    next.set(run.attemptId, [...(before.get(run.attemptId) ?? []), run.tokens].slice(-keep));
  }
  return next;
}

/** Goals (their ids) that are done now and were not when `before` was taken; the first look finds none. */
export function newlyDone(before: ReadonlyMap<string, string> | undefined, tasks: readonly Placed[]): string[] {
  if (before === undefined) return [];
  return tasks.filter(({ task }) => task.parentId === null && task.state === "done" && before.has(task.id) && before.get(task.id) !== "done").map(({ task }) => task.id);
}

/** The states of the goals, to compare with the next look. */
export const goalStates = (tasks: readonly Placed[]): Map<string, string> => new Map(tasks.filter(({ task }) => task.parentId === null).map(({ task }) => [task.id, task.state]));

/** Finished against finished plus failed, as 0..1; null when nothing ended. */
export const successRate = (done: number, failed: number): number | null => (done + failed === 0 ? null : done / (done + failed));

/** The points of a small area chart: `values` spread over `width` by `height`, as a closed path and its top line. */
export function areaPath(values: readonly number[], width: number, height: number, pad = 2): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index): [number, number] => [index * step, height - pad - (value / max) * (height - pad * 2)]);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${width} ${height} L0 ${height} Z` };
}
