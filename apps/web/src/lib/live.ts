import type { Overview, OverviewEvent, Queue } from "@brain/contracts";

/**
 * The shaping behind the Live screen: pure functions over what the Overview, the Queue and `tasks.list` already answer.
 * Nothing here reads the clock or the page; the screen passes `now`.
 */

const HOUR = 3_600_000;

/** The stages of the flow, left to right. Failed branches off Running. */
export const STAGES = ["queued", "running", "checking", "needs", "done", "failed"] as const;
export type Stage = (typeof STAGES)[number];
export type StageCounts = Readonly<Record<Stage, number>>;

/**
 * How many are at each stage: Queued and Running are what the Queue says now (a check running is counted under Checking, not Running),
 * Needs you is what waits for a person, Done and Failed are the tasks of the last hour that ended, as the Governor counted them (goals themselves are not counted twice).
 */
export function stageCounts(queue: Queue | undefined, overview: Overview | undefined): StageCounts {
  const runs = (queue?.runners ?? []).flatMap((runner) => runner.occupied);
  const checking = runs.filter((run) => run.kind === "check").length;
  const running = Math.max(0, (queue?.running ?? runs.length) - checking);
  const ended = (state: "done" | "failed"): number => (overview?.workspaces ?? []).reduce((sum, workspace) => sum + workspace.lastHour[state], 0);
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

type FeedKind = "goal-done" | "goal-failed" | "goal-started" | "task-done" | "task-failed" | "task-started" | "task-stopped" | "approval" | "approved" | "check-passed" | "check-failed" | "question" | "plan" | "sign-off" | "judge" | "failed-subtask";

export interface FeedEvent {
  /** The audit event's position: one event has one id however often the Governor tells it. */
  readonly id: number;
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

const NEEDS: Readonly<Record<string, FeedKind>> = { approval: "approval", check: "check-failed", answer: "question", "confirm-plan": "plan", "sign-off": "sign-off", judge: "judge", "failed-subtask": "failed-subtask" };

/** What an event means in the feed; null for one that needs no line (a goal that waits is left to the task under it). */
function kindOf(event: OverviewEvent): FeedKind | null {
  switch (event.type) {
    case "task.done": return event.goal ? "goal-done" : "task-done";
    case "task.failed": return event.goal ? "goal-failed" : "task-failed";
    case "task.stopped": return "task-stopped";
    case "task.running": return event.goal ? "goal-started" : "task-started";
    case "task.checked": return event.pass ? "check-passed" : "check-failed";
    case "approval.approved": return "approved";
    case "task.needs_you": return event.goal ? null : (NEEDS[event.need ?? ""] ?? null);
  }
}

/** The feed's events, one for each audit event the Governor told of (and none for one that needs no line), newest first. */
export function feedEvents(events: readonly OverviewEvent[], names: ReadonlyMap<string, { slug: string; name: string }>): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const event of events) {
    const kind = kindOf(event);
    const place = names.get(event.workspaceId);
    if (kind === null || !place) continue;
    out.push({ id: event.id, at: event.at, kind, slug: place.slug, workspace: place.name, agent: event.agent, taskId: event.taskId, rootId: event.rootId, goalTitle: event.goalTitle, title: event.title });
  }
  return out.sort((a, b) => b.at - a.at || b.id - a.id);
}

/** The events told so far, each once by its id, the newest `keep` of those not older than `maxAgeMs`: the feed grows as answers arrive and does not forget between them. */
export function mergeEvents(before: ReadonlyMap<number, OverviewEvent>, told: readonly OverviewEvent[], now: number, maxAgeMs = 6 * HOUR, keep = 400): Map<number, OverviewEvent> {
  const all = new Map(before);
  for (const event of told) all.set(event.id, event);
  return new Map([...all].filter(([, event]) => now - event.at <= maxAgeMs).sort((a, b) => b[1].at - a[1].at || b[0] - a[0]).slice(0, keep));
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
  const seen = new Set<number>();
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

/** The goals that finished since the last look: those the Governor tells of that were not told before. The first look finds none. */
export const newGoals = (before: ReadonlySet<string> | undefined, goals: ReadonlyArray<{ readonly id: string }>): string[] => (before === undefined ? [] : goals.filter((goal) => !before.has(goal.id)).map((goal) => goal.id));

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
