import type { LogRecord } from "./LogTail";
import { TOOL_JOIN_TYPES, assistantDelta, proposalKeyOf } from "./LogRow";
import type { EntryRowModel, LogRowModel } from "./LogRow";
import { plainSentence, taskStatusLine } from "./plain-event";
import type { TaskInfo } from "./plain-event";

/**
 * The Readable log model: records grouped by the task they belong to, with
 * streamed message chunks joined into one message per turn and runs of
 * identical generic lines counted instead of repeated. Raw mode never goes
 * through here. Pure over the records plus the task lookup, so it is cheap to
 * rebuild when the tail merges.
 */

/** Records that say nothing about where a turn ends: they may sit between its chunks. */
const TURN_NOISE = new Set(["attempt.progress", "usage"]);
const NO_TASK = "none";
/** How many rows back an identical routine line may be counted onto. */
const LOOKBACK = 8;
const SEVERITY_ORDER = ["debug", "info", "warning", "error", "critical"];

const rowModels = new WeakMap<LogRecord, { members: readonly LogRecord[]; partial: boolean; model: EntryRowModel }>();

function cached(first: LogRecord, members: readonly LogRecord[], partial: boolean, build: () => EntryRowModel): EntryRowModel {
  const hit = rowModels.get(first);
  if (hit && hit.partial === partial && hit.members.length === members.length && hit.members.every((member, index) => member === members[index])) return hit.model;
  const model = build();
  rowModels.set(first, { members, partial, model });
  return model;
}

const sessionKeyOf = (record: LogRecord): string => record.correlation?.sessionId ?? record.aggregateId;

/**
 * Which task each record belongs to. A record that names its work item says
 * so; one that only names a session, job, run or attempt borrows the task of
 * any record in the window that links the same id to a work item.
 */
export function resolveTasks(records: readonly LogRecord[]): readonly string[] {
  const learned = new Map<string, string>();
  const keysOf = (record: LogRecord): string[] => {
    const c = record.correlation;
    return [c?.sessionId && `s:${c.sessionId}`, c?.jobId && `j:${c.jobId}`, c?.runId && `r:${c.runId}`, c?.attemptId && `a:${c.attemptId}`]
      .filter((key): key is string => typeof key === "string");
  };
  for (const record of records) {
    const taskId = record.correlation?.workItemId;
    if (taskId) for (const key of keysOf(record)) if (!learned.has(key)) learned.set(key, taskId);
  }
  return records.map((record) => {
    const own = record.correlation?.workItemId;
    if (own) return own;
    for (const key of keysOf(record)) {
      const found = learned.get(key);
      if (found) return found;
    }
    return NO_TASK;
  });
}

interface Options {
  readonly tasks: Readonly<Record<string, TaskInfo>>;
  /** Task ids whose entries are folded away behind their header. */
  readonly collapsed: ReadonlySet<string>;
  /** True when the seed window is full, so its oldest chunk may begin mid-word. */
  readonly windowFull: boolean;
}

function worst(records: readonly LogRecord[]): string | null {
  let out: string | null = null;
  for (const record of records) {
    const rank = record.severity ? SEVERITY_ORDER.indexOf(record.severity) : -1;
    if (rank >= 0 && (out === null || rank > SEVERITY_ORDER.indexOf(out))) out = record.severity;
  }
  return out;
}

function rowRecords(row: LogRowModel): readonly LogRecord[] {
  if (row.kind === "task") return [];
  return row.kind === "tool" || row.kind === "repeat" || row.kind === "message" ? row.members : [row.record];
}

function entriesOf(records: readonly LogRecord[], windowFull: boolean, firstOfSession: ReadonlyMap<string, LogRecord>): EntryRowModel[] {
  const rows: EntryRowModel[] = [];
  const openTools = new Map<string, { index: number; members: LogRecord[]; proposed?: LogRecord; result?: LogRecord }>();
  const openMessages = new Map<string, number>();
  const signatures = new Map<LogRecord, string>();

  for (const record of records) {
    const session = sessionKeyOf(record);
    const delta = assistantDelta(record);
    if (delta !== undefined) {
      const key = `${session}|${record.emitter}`;
      const at = openMessages.get(key);
      const open = at === undefined ? undefined : rows[at];
      if (at !== undefined && open?.kind === "message") {
        const members = [...open.members, record];
        const text = `${open.text}${delta}`;
        const partial = open.partialStart === true;
        rows[at] = cached(open.record, members, partial, () => ({ kind: "message", record: open.record, members, text, partialStart: partial }));
      } else {
        openMessages.set(key, rows.length);
        const partial = windowFull && firstOfSession.get(session) === record;
        rows.push(cached(record, [record], partial, () => ({ kind: "message", record, members: [record], text: delta, partialStart: partial })));
      }
      continue;
    }
    // Anything but noise ends the turn that session was speaking.
    if (!TURN_NOISE.has(record.type)) {
      for (const key of [...openMessages.keys()]) if (key.startsWith(`${session}|`)) openMessages.delete(key);
    }
    const proposal = proposalKeyOf(record);
    if (proposal && TOOL_JOIN_TYPES.has(record.type)) {
      const existing = openTools.get(proposal);
      if (existing) {
        existing.members.push(record);
        if (record.type === "tool.proposed") existing.proposed ??= record;
        if (record.type === "tool.result") existing.result ??= record;
        const members = [...existing.members];
        const proposed = existing.proposed;
        const result = existing.result;
        rows[existing.index] = cached(existing.members[0]!, members, false, () => ({ kind: "tool", proposalKey: proposal, members, proposed, result }));
      } else {
        const group = { index: rows.length, members: [record], proposed: record.type === "tool.proposed" ? record : undefined, result: undefined };
        openTools.set(proposal, group);
        rows.push(cached(record, group.members, false, () => ({ kind: "tool", proposalKey: proposal, members: [record], proposed: group.proposed, result: undefined })));
      }
      continue;
    }
    // The same plain sentence twice in a row is one counted line, however the payloads differ.
    const signature = `${record.severity ?? ""}|${plainSentence(record, undefined, undefined, false)}`;
    // Failures stay their own lines; routine lines that say the same thing as a
    // recent one (a few rows back at most) are counted on that line.
    const routine = record.severity !== "error" && record.severity !== "critical";
    let at = -1;
    for (let back = 1; routine && back <= LOOKBACK && at < 0; back += 1) {
      const candidate = rows[rows.length - back];
      if (!candidate) break;
      if ((candidate.kind === "single" || candidate.kind === "repeat") && signatures.get(candidate.record) === signature) at = rows.length - back;
    }
    const target = at >= 0 ? rows[at] : undefined;
    if (target && (target.kind === "single" || target.kind === "repeat")) {
      const first = target.record;
      const members = target.kind === "repeat" ? [...target.members, record] : [target.record, record];
      rows[at] = cached(first, members, false, () => ({ kind: "repeat", record: first, members }));
    } else {
      signatures.set(record, signature);
      rows.push(cached(record, [record], false, () => ({ kind: "single", record })));
    }
  }
  return rows;
}

/**
 * Rows for the Readable view: one header per task (least recently active
 * first, so the newest activity ends the list) followed by that task's entries
 * unless the header is collapsed.
 */
export function buildReadableRows(records: readonly LogRecord[], options: Options): readonly LogRowModel[] {
  const taskIds = resolveTasks(records);
  const order: string[] = [];
  const byTask = new Map<string, LogRecord[]>();
  const lastIndex = new Map<string, number>();
  const firstOfSession = new Map<string, LogRecord>();
  records.forEach((record, index) => {
    const taskId = taskIds[index]!;
    let list = byTask.get(taskId);
    if (!list) { list = []; byTask.set(taskId, list); order.push(taskId); }
    list.push(record);
    lastIndex.set(taskId, index);
    const session = sessionKeyOf(record);
    if (!firstOfSession.has(session)) firstOfSession.set(session, record);
  });
  order.sort((a, b) => (lastIndex.get(a) ?? 0) - (lastIndex.get(b) ?? 0));

  const out: LogRowModel[] = [];
  for (const taskId of order) {
    const entries = entriesOf(byTask.get(taskId)!, options.windowFull, firstOfSession);
    const info = taskId === NO_TASK ? undefined : options.tasks[taskId];
    const collapsed = options.collapsed.has(taskId);
    out.push({
      kind: "task",
      taskId,
      title: taskId === NO_TASK ? "Not tied to a task" : info?.title ?? "A task that is no longer listed",
      status: taskId === NO_TASK ? "activity outside any task" : taskStatusLine(info),
      entries: entries.length,
      collapsed,
      severity: worst(entries.flatMap(rowRecords)),
    });
    if (!collapsed) out.push(...entries);
  }
  return out;
}
