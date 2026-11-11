import type { SessionDetail } from "../../data/exec-console";

/** The part of a transcript entry the sentence needs; the console's feed entries satisfy it. */
export interface ActivityEntry {
  readonly streamSeq: number;
  readonly at: string;
  readonly type: string;
  readonly kind: "message" | "tool" | "state" | "system";
  readonly tool?: { readonly name?: string; readonly result?: unknown };
}

/**
 * The plain "doing now" sentence and the ETA band (#61). Both are pure and
 * deterministic: the sentence is derived from the structured session events
 * (tool calls and their results, messages) and the session and task state,
 * never from a model summary; the band compares elapsed time with the plan
 * task's estimate and says so when there is none.
 */

/** What the feed has seen so far, reported upward so the header can say what the session is doing. */
export interface FeedActivity {
  readonly latest?: ActivityEntry;
  readonly lastTool?: ActivityEntry;
  readonly lastMessage?: ActivityEntry;
  readonly toolCalls: number;
  /** Consecutive reading tool calls at the end of the tool history (documents, web pages, knowledge, tables, files). */
  readonly readingStreak: number;
  readonly firstAt?: string;
}

export const NO_ACTIVITY: FeedActivity = { toolCalls: 0, readingStreak: 0 };

/** Tools that gather sources: the registry's read tools plus the engines' own file and search tools. */
const READING_NAMES: ReadonlySet<string> = new Set(["documents.read", "web.fetch", "knowledge.search", "csv.query"]);
const READING_VERBS: ReadonlySet<string> = new Set(["read", "view", "fetch", "search", "grep", "glob", "ls", "cat", "find"]);

export function isReadingTool(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return READING_NAMES.has(lower) || READING_VERBS.has(lower.split(/[._-]/)[0] ?? "");
}

export function summarizeActivity(entries: readonly ActivityEntry[]): FeedActivity {
  let lastTool: ActivityEntry | undefined;
  let lastMessage: ActivityEntry | undefined;
  let toolCalls = 0;
  let readingStreak = 0;
  for (const entry of entries) {
    if (entry.kind === "tool") {
      lastTool = entry;
      toolCalls += 1;
      readingStreak = isReadingTool(entry.tool?.name) ? readingStreak + 1 : 0;
    } else if (entry.kind === "message" && entry.type === "text") lastMessage = entry;
  }
  const latest = entries.at(-1);
  return { ...(latest ? { latest } : {}), ...(lastTool ? { lastTool } : {}), ...(lastMessage ? { lastMessage } : {}), toolCalls, readingStreak, ...(entries[0] ? { firstAt: entries[0].at } : {}) };
}

/** The task's own state when it is known: a task in review is waiting for its independent check. */
export type TaskState = "backlog" | "ready" | "in-progress" | "blocked" | "review" | "done" | "abandoned";

const sources = (count: number) => `${count} ${count === 1 ? "source" : "sources"}`;

/** The plain sentence for the session's current condition, built from its latest tool and message. */
export function nowSentence(session: Pick<SessionDetail, "state"> | undefined, activity: FeedActivity, taskState?: TaskState): string {
  const state = session?.state;
  if (state === "failed") return "This session stopped because of an error. The last activity is listed below.";
  if (taskState === "review" && (state === undefined || state === "stopped" || state === "waiting")) return "Waiting for the independent check of this task's result.";
  if (state === "stopped") return "This session has finished. Its full transcript is below.";
  if (state === "stopping") return "A stop was requested; the session is wrapping up.";
  if (state === "starting") return "The agent is starting up and will begin working shortly.";
  if (state === "waiting") return "The agent is waiting for a person before it continues.";
  const tool = activity.lastTool;
  const message = activity.lastMessage;
  if (tool && (!message || tool.streamSeq > message.streamSeq)) {
    const name = tool.tool?.name ?? "a tool";
    const done = Boolean(tool.tool?.result);
    if (isReadingTool(tool.tool?.name) && activity.readingStreak > 0) return done ? `Read ${sources(activity.readingStreak)}; deciding the next step.` : `Reading ${sources(activity.readingStreak)}…`;
    return done ? `Ran ${name}; deciding the next step.` : `Running ${name}…`;
  }
  if (message) return "Writing an update; the latest message is at the bottom of the transcript.";
  return state === "running" ? "Working. The first activity will appear here in a moment." : "No activity has been recorded for this session yet.";
}

/** The one line a task row shows when only the session and task state are at hand (no transcript is loaded). */
export function taskNowLine(taskState: TaskState | undefined, sessionState: string | undefined): string | undefined {
  if (taskState === "review") return "Waiting for the independent check.";
  if (sessionState === "waiting") return "Waiting for a person before it continues.";
  if (sessionState === "starting") return "Starting up.";
  if (sessionState === "running") return "Working on it now.";
  if (sessionState === "stopping") return "Wrapping up after a stop request.";
  return undefined;
}

/** "42s", "3 min 5s", "2 h 4 min" — or undefined for a start time that is missing or implausible (an unset timestamp). */
export function elapsedText(from: string | undefined, to: number): string | undefined {
  const start = from ? Date.parse(from) : Number.NaN;
  if (!Number.isFinite(start) || start <= 0 || to < start || to - start > 30 * 86_400_000) return undefined;
  const seconds = Math.floor((to - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60}s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface EtaBand {
  /** unknown: no estimate; within: under the estimate; over: past it; done: finished. */
  readonly kind: "unknown" | "within" | "over" | "done";
  readonly label: string;
  /** Share of the estimate used, 0 to 1 (1 when over); absent when unknown. */
  readonly fraction?: number;
}

const minutesWords = (minutes: number) => {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  return rounded % 60 ? `${Math.floor(rounded / 60)} h ${rounded % 60} min` : `${rounded / 60} h`;
};

/**
 * Elapsed time against the plan task's estimate. No estimate (or an invalid
 * one) is "unknown", never a guess; past the estimate says by how much.
 */
export function etaBand(input: { estimatedMinutes?: number; startedAt?: string; nowMs: number; endedAtMs?: number; finished?: boolean }): EtaBand {
  const estimate = input.estimatedMinutes;
  const started = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const end = input.finished && input.endedAtMs ? input.endedAtMs : input.nowMs;
  const elapsedMin = Number.isFinite(started) && started > 0 && end >= started ? (end - started) / 60_000 : undefined;
  if (!estimate || estimate <= 0 || !Number.isFinite(estimate)) return { kind: "unknown", label: "No time estimate for this task" };
  if (elapsedMin === undefined) return { kind: "unknown", label: `Estimated about ${minutesWords(estimate)}` };
  if (input.finished) return { kind: "done", label: `Took ${minutesWords(elapsedMin)}; estimated ${minutesWords(estimate)}`, fraction: Math.min(1, elapsedMin / estimate) };
  if (elapsedMin >= estimate) return { kind: "over", label: `${minutesWords(elapsedMin - estimate)} past the estimate of ${minutesWords(estimate)}`, fraction: 1 };
  return { kind: "within", label: `${minutesWords(elapsedMin)} of about ${minutesWords(estimate)} · about ${minutesWords(estimate - elapsedMin)} left`, fraction: elapsedMin / estimate };
}
