import type { AttemptKind, AttemptState, Task, TaskState } from "@brain/contracts";

/**
 * The Timeline of a goal (docs/model.md, "The timeline and Insights"), as plain data: one row per task, grouped by agent, with a bar for each attempt,
 * the stretches a person was waited for, a tick for each tool call, and the critical path. No text and no DOM: the component draws it, and the time
 * scale, the packing of overlapping attempts and the critical path are checked on their own.
 */
export type WaitKind = "approval" | "question" | "sign-off";
export interface TimelineBar {
  readonly id: string;
  readonly taskId: string;
  readonly kind: AttemptKind;
  readonly state: AttemptState;
  readonly agent: string;
  readonly round: number;
  /** When the attempt was queued, when it started (the queue wait is between), and when it ended (now while it runs). */
  readonly queuedAt: number;
  readonly start: number;
  readonly end: number;
  readonly lane: number;
  readonly microUsd: number;
  readonly tokens: number;
  /** An earlier attempt of the same task, kind and round failed: this one runs it again. */
  readonly retry: boolean;
}
/** A stretch in which a person was asked for something. `open` while nobody has answered. */
export interface TimelineWait { readonly id: string; readonly taskId: string; readonly kind: WaitKind; readonly tool: string; readonly from: number; readonly to: number; readonly open: boolean }
export interface TimelineTick { readonly at: number; readonly attemptId: string; readonly tool: string; readonly failed: boolean }
export interface TimelineRow {
  readonly taskId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly agent: string;
  /** How many lanes the row needs: attempts that overlap in time (candidates) sit in their own. */
  readonly lanes: number;
  readonly bars: readonly TimelineBar[];
  readonly waits: readonly TimelineWait[];
  readonly ticks: readonly TimelineTick[];
}
export interface Timeline {
  readonly start: number;
  readonly end: number;
  readonly groups: ReadonlyArray<{ readonly agent: string; readonly rows: readonly TimelineRow[] }>;
  /** The tasks whose chain sets when the goal can finish. */
  readonly critical: ReadonlySet<string>;
  /** Tasks that have not started: they have nothing to draw. */
  readonly notStarted: number;
}

/**
 * Gives each interval the first lane whose last interval has ended; intervals are placed in the order of their start. Returns the lane of each, in the given order.
 * An interval shorter than `least` takes that much room, so attempts too short to see do not hide each other.
 */
export function packLanes(intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>, least = 0): number[] {
  const ends: number[] = [];
  const lanes = intervals.map(() => 0);
  intervals.map((interval, index) => ({ interval, index })).sort((a, b) => a.interval.start - b.interval.start || a.index - b.index).forEach(({ interval, index }) => {
    let lane = ends.findIndex((end) => end <= interval.start);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = Math.max(interval.end, interval.start + Math.max(1, least));
    lanes[index] = lane;
  });
  return lanes;
}

interface Node { readonly id: string; readonly parentId: string | null; readonly waitsFor: readonly string[]; readonly end: number | null }
/**
 * The chain of tasks that sets when the goal can finish: from the task that ends last, back through the task it waited for that ended last, and so on.
 * A copy of a `for_each` step waits for what its step waits for, and a task that waits for a step waits for its copies.
 */
export function criticalPath(nodes: readonly Node[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leaves = (id: string): string[] => { const below = nodes.filter((node) => node.parentId === id); return below.length === 0 ? [id] : below.flatMap((node) => leaves(node.id)); };
  const before = (node: Node): string[] => [...node.waitsFor.flatMap(leaves), ...(node.parentId !== null && byId.has(node.parentId) ? before(byId.get(node.parentId) as Node) : [])];
  const ended = (id: string): number => byId.get(id)?.end ?? -Infinity;
  const path = new Set<string>();
  let current = nodes.filter((node) => node.end !== null && !nodes.some((other) => other.parentId === node.id)).sort((a, b) => (b.end as number) - (a.end as number))[0];
  while (current && !path.has(current.id)) {
    path.add(current.id);
    const next: string | undefined = before(current).filter((id) => byId.has(id) && ended(id) > -Infinity).sort((a, b) => ended(b) - ended(a))[0];
    current = next === undefined ? undefined : byId.get(next);
  }
  return path;
}

const BEFORE_PERSON = new Set(["sign-off", "check", "judge", "confirm-plan"]);
const RUNNING = new Set<AttemptState>(["queued", "offered", "running"]);

export function buildTimeline(record: Task, now: number): Timeline {
  const tasks = [record, ...record.subtasks];
  const attemptsOf = (taskId: string) => record.attempts.filter((attempt) => attempt.taskId === taskId);
  const rows: Array<{ row: TimelineRow; first: number; end: number | null }> = [];
  let notStarted = 0;
  let start = Infinity;
  let end = -Infinity;
  const span = (at: number): void => { start = Math.min(start, at); end = Math.max(end, at); };
  // About a hundredth of the whole is the least an attempt is given room for.
  const times = record.attempts.flatMap((attempt) => [attempt.createdAt, attempt.finishedAt ?? (RUNNING.has(attempt.state) || attempt.state === "held" ? now : attempt.createdAt)]);
  const least = (Math.max(...times) - Math.min(...times)) / 80;
  for (const task of tasks) {
    const mine = attemptsOf(task.id);
    const bars = mine.map((attempt) => {
      const begun = attempt.startedAt ?? attempt.createdAt;
      const over = attempt.finishedAt ?? (RUNNING.has(attempt.state) || attempt.state === "held" ? now : begun);
      return { attempt, start: begun, end: Math.max(begun, over) };
    });
    const tickOf = record.toolCalls.filter((call) => mine.some((attempt) => attempt.id === call.attemptId));
    const waits: TimelineWait[] = [];
    for (const approval of record.approvals.filter((entry) => entry.taskId === task.id && !entry.standing)) {
      const open = approval.decidedAt === null && approval.state === "pending";
      waits.push({ id: approval.id, taskId: task.id, kind: "approval", tool: approval.tool, from: approval.requestedAt, to: approval.decidedAt ?? (open ? now : approval.requestedAt), open });
    }
    for (const call of tickOf.filter((entry) => entry.tool === "task.ask")) {
      const answered = call.output !== null && typeof call.output === "object" && !Array.isArray(call.output) && (call.output as { status?: unknown }).status === "answered" ? (call.output as { at?: unknown }).at : undefined;
      waits.push({ id: call.id, taskId: task.id, kind: "question", tool: call.tool, from: call.at, to: typeof answered === "number" ? answered : now, open: typeof answered !== "number" });
    }
    const lastEnd = (before: number): number => Math.max(0, ...bars.filter((bar) => bar.end <= before).map((bar) => bar.end));
    for (const check of record.checks.filter((entry) => entry.taskId === task.id && entry.by.kind === "person")) waits.push({ id: `check-${check.id}`, taskId: task.id, kind: "sign-off", tool: "", from: lastEnd(check.at), to: check.at, open: false });
    if (task.state === "needs_you" && task.needs !== null && BEFORE_PERSON.has(task.needs.kind)) waits.push({ id: `open-${task.id}`, taskId: task.id, kind: "sign-off", tool: "", from: lastEnd(now), to: now, open: true });
    const shown = waits.filter((wait) => wait.from > 0);
    if (bars.length === 0 && shown.length === 0) { if (task.agent !== null) notStarted += 1; continue; }
    const lanes = packLanes(bars, least);
    const placed: TimelineBar[] = bars.map(({ attempt, start: from, end: to }, index) => ({
      id: attempt.id, taskId: task.id, kind: attempt.kind, state: attempt.state, agent: attempt.agent, round: attempt.round, queuedAt: Math.min(attempt.createdAt, from), start: from, end: to, lane: lanes[index] as number,
      microUsd: attempt.usage.microUsd, tokens: attempt.usage.inputTokens + attempt.usage.outputTokens,
      retry: mine.some((other) => other.kind === attempt.kind && other.round === attempt.round && other.id !== attempt.id && other.state === "failed" && other.createdAt < attempt.createdAt),
    }));
    for (const bar of placed) { span(bar.queuedAt); span(bar.end); }
    for (const wait of shown) { span(wait.from); span(wait.to); }
    const agent = task.agent ?? placed[0]?.agent ?? "";
    rows.push({
      row: { taskId: task.id, title: task.title, state: task.state, agent, lanes: Math.max(1, ...lanes.map((lane) => lane + 1)), bars: placed, waits: shown, ticks: tickOf.map((call) => ({ at: call.at, attemptId: call.attemptId, tool: call.tool, failed: call.outcome === "failed" || call.outcome === "rejected" })) },
      first: Math.min(...placed.map((bar) => bar.queuedAt), ...shown.map((wait) => wait.from)), end: placed.length > 0 ? Math.max(...placed.map((bar) => bar.end)) : null,
    });
  }
  const order = new Map<string, number>();
  for (const { row, first } of [...rows].sort((a, b) => a.first - b.first)) if (!order.has(row.agent)) order.set(row.agent, first);
  const groups = [...order.keys()].map((agent) => ({ agent, rows: rows.filter(({ row }) => row.agent === agent).sort((a, b) => a.first - b.first).map(({ row }) => row) }));
  const ended = new Map(rows.map(({ row, end: over }) => [row.taskId, over]));
  const critical = criticalPath(record.subtasks.map((sub) => ({ id: sub.id, parentId: sub.parentId === record.id ? null : sub.parentId, waitsFor: sub.waitsFor, end: ended.get(sub.id) ?? null })));
  if (!Number.isFinite(start)) { start = now - 60_000; end = now; }
  const pad = Math.max(1000, (end - start) * 0.02);
  return { start: start - pad / 2, end: end + pad, groups, critical, notStarted };
}

// --- the time axis ---

/** The part of the time axis in view. */
export interface View { readonly from: number; readonly to: number }
export const MIN_SPAN_MS = 1000;

/** Where `at` falls in the view, from 0 at its start to 1 at its end (the page's reading direction decides which side that is). */
export const fractionOf = (view: View, at: number): number => (at - view.from) / (view.to - view.from);

/** The view after zooming by `factor` (above 1 shows less time) around the place `anchor` (0 to 1) of it, kept inside `whole`. */
export function zoom(view: View, whole: View, factor: number, anchor = 0.5): View {
  const span = Math.min(whole.to - whole.from, Math.max(MIN_SPAN_MS, (view.to - view.from) / factor));
  const from = view.from + (view.to - view.from) * anchor - span * anchor;
  return slide({ from, to: from + span }, whole);
}
/** The view moved by `by` of its own width, kept inside `whole`. */
export const pan = (view: View, whole: View, by: number): View => slide({ from: view.from + (view.to - view.from) * by, to: view.to + (view.to - view.from) * by }, whole);
function slide(view: View, whole: View): View {
  const span = view.to - view.from;
  const from = Math.min(Math.max(view.from, whole.from), Math.max(whole.from, whole.to - span));
  return { from, to: from + span };
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 604_800].map((seconds) => seconds * 1000);
/** Times for the axis: whole steps of 1 s to 1 week, about `target` of them, aligned to the person's own midnight (`offsetMs` east of UTC). */
export function ticks(view: View, target: number, offsetMs = 0): number[] {
  const step = STEPS.find((candidate) => (view.to - view.from) / candidate <= target) ?? (STEPS.at(-1) as number);
  const out: number[] = [];
  for (let at = Math.ceil((view.from + offsetMs) / step) * step - offsetMs; at <= view.to; at += step) out.push(at);
  return out;
}
