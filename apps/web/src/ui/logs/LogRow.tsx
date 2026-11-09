import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { streamSummaryText } from "../exec/StreamEventRow";
import { severityDotClass, severityLabel } from "../screen-region";
import type { LogRecord } from "./LogTail";

/**
 * One row of the Log Explorer's virtualized list: fixed height (the window
 * math of VirtualLogList depends on it), rendered in a Readable mode (time,
 * severity, source, event type, bounded summary) or a Raw mode that preserves
 * the original redacted record — sequence, timestamp, emitter and the payload
 * reference — beside the grouped presentation. Expansion happens in the
 * explorer's detail pane, so rows never grow.
 */

/** Fixed row height in px; VirtualLogList positions rows by it. */
export const ROW_HEIGHT = 32;

/**
 * The grouped display model. Tool invocations keep their start (proposal),
 * progress and result — including errors — together under one row; runs of
 * consecutive repetitive lines collapse into one counted row. Grouping never
 * reorders records: a tool group sits where its first record sits.
 */
export type LogRowModel =
  | { readonly kind: "single"; readonly record: LogRecord }
  | { readonly kind: "repeat"; readonly record: LogRecord; readonly members: readonly LogRecord[] }
  /** A run of streamed assistant text deltas read as one message. */
  | { readonly kind: "message"; readonly record: LogRecord; readonly members: readonly LogRecord[]; readonly text: string }
  | { readonly kind: "tool"; readonly proposalKey: string; readonly members: readonly LogRecord[]; readonly proposed?: LogRecord; readonly result?: LogRecord };

/** Records that belong to one tool invocation join by proposal id. */
const TOOL_JOIN_TYPES = new Set(["tool.proposed", "tool.result", "attempt.progress"]);

function proposalKeyOf(record: LogRecord): string | undefined {
  const payload = record.summary && typeof record.summary === "object" && !Array.isArray(record.summary)
    ? record.summary as Record<string, unknown> : undefined;
  const fromPayload = typeof payload?.["proposalId"] === "string" ? payload["proposalId"] : undefined;
  const key = fromPayload ?? record.correlation?.proposalId ?? record.correlation?.invocationId;
  return key && key.length > 0 ? key : undefined;
}

/** The tool's declared identity from the proposal payload (never invented). */
export function toolIdentity(record: LogRecord | undefined): string {
  const payload = record?.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : undefined;
  const tool = payload?.["tool"];
  if (tool && typeof tool === "object" && typeof (tool as Record<string, unknown>)["id"] === "string") {
    return String((tool as Record<string, unknown>)["id"]);
  }
  return "tool invocation";
}

export interface ToolReceiptView {
  readonly result: string | undefined;
  readonly exitCode: number | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly effects: readonly unknown[];
  readonly invocationId: string | undefined;
}

/** The tool receipt carried by a `tool.result` summary, read defensively. */
export function receiptOf(record: LogRecord | undefined): ToolReceiptView | undefined {
  const payload = record?.summary && typeof record.summary === "object" && !Array.isArray(record.summary)
    ? record.summary as Record<string, unknown> : undefined;
  const receipt = payload?.["receipt"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const view = receipt as Record<string, unknown>;
  return {
    result: typeof view["result"] === "string" ? view["result"] : undefined,
    exitCode: typeof view["exitCode"] === "number" ? view["exitCode"] : undefined,
    startedAt: typeof view["startedAt"] === "string" ? view["startedAt"] : undefined,
    finishedAt: typeof view["finishedAt"] === "string" ? view["finishedAt"] : undefined,
    stdout: view["stdout"],
    stderr: view["stderr"],
    effects: Array.isArray(view["effects"]) ? view["effects"] : [],
    invocationId: typeof view["invocationId"] === "string" ? view["invocationId"] : undefined,
  };
}

/** Duration text from the receipt's start/finish stamps; "—" while open. */
export function receiptDuration(receipt: ToolReceiptView | undefined): string {
  if (!receipt?.startedAt || !receipt.finishedAt) return "—";
  const start = Date.parse(receipt.startedAt);
  const end = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const ms = end - start;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Rows rebuild whenever the tail merges; the mounted window's models must keep
 * their identity when their records did not change, so the virtualiser can
 * keep those rows' DOM (and any text selection inside them) alive across live
 * appends. Records keep their identity across appends (the tail merges by
 * reference), so first-record identity plus an element-wise members check is a
 * sound cache key: a run that grows gets a new model, an unchanged row is
 * reused. The WeakMap follows records out of the bounded window.
 */
const rowModels = new WeakMap<LogRecord, { members: readonly LogRecord[]; model: LogRowModel }>();

function cachedRow(first: LogRecord, members: readonly LogRecord[], build: () => LogRowModel): LogRowModel {
  const hit = rowModels.get(first);
  if (hit && hit.members.length === members.length && hit.members.every((member, index) => member === members[index])) return hit.model;
  const model = build();
  rowModels.set(first, { members, model });
  return model;
}

/** The assistant text of a streamed `text` delta, or undefined for any other record. */
function assistantDelta(record: LogRecord): string | undefined {
  if (record.type !== "text") return undefined;
  const payload = record.summary && typeof record.summary === "object" && !Array.isArray(record.summary) ? record.summary as Record<string, unknown> : undefined;
  if (!payload || (typeof payload["channel"] === "string" && payload["channel"] !== "assistant")) return undefined;
  return typeof payload["text"] === "string" ? payload["text"] : undefined;
}

export function buildLogRows(records: readonly LogRecord[]): readonly LogRowModel[] {
  const rows: LogRowModel[] = [];
  const openTools = new Map<string, { index: number; members: LogRecord[]; proposed?: LogRecord; result?: LogRecord }>();
  let previous: { type: string; emitter: string; severity: string | null; summary: string } | undefined;

  const pushOrRepeat = (record: LogRecord): void => {
    const signature = { type: record.type, emitter: record.emitter, severity: record.severity, summary: streamSummaryText(record.summary, 160) };
    const last = rows.at(-1);
    if (previous
      && previous.type === signature.type && previous.emitter === signature.emitter
      && previous.severity === signature.severity && previous.summary === signature.summary
      && last && last.kind !== "tool") {
      // Collapse one more consecutive repetitive line into the previous row.
      const first = last.record;
      const members = last.kind === "repeat" ? [...last.members, record] : [last.record, record];
      rows[rows.length - 1] = cachedRow(first, members, () => ({ kind: "repeat", record: first, members }));
      previous = signature;
      return;
    }
    rows.push(cachedRow(record, [record], () => ({ kind: "single", record })));
    previous = signature;
  };

  for (const record of records) {
    const delta = assistantDelta(record);
    if (delta !== undefined) {
      const last = rows.at(-1);
      if (last?.kind === "message" && last.record.aggregateId === record.aggregateId && last.record.emitter === record.emitter && !last.text.endsWith("\n")) {
        const members = [...last.members, record];
        const text = `${last.text}${delta}`;
        rows[rows.length - 1] = cachedRow(last.record, members, () => ({ kind: "message", record: last.record, members, text }));
      } else {
        rows.push(cachedRow(record, [record], () => ({ kind: "message", record, members: [record], text: delta })));
      }
      previous = undefined;
      continue;
    }
    const key = proposalKeyOf(record);
    if (key && TOOL_JOIN_TYPES.has(record.type)) {
      const existing = openTools.get(key);
      if (existing) {
        existing.members.push(record);
        if (record.type === "tool.proposed") existing.proposed ??= record;
        if (record.type === "tool.result") existing.result ??= record;
        const members = [...existing.members];
        const proposed = existing.proposed;
        const result = existing.result;
        rows[existing.index] = cachedRow(existing.members[0]!, members,
          () => ({ kind: "tool", proposalKey: key, members, proposed, result }));
        // A tool row breaks any consecutive-repeat run before it.
        previous = undefined;
        continue;
      }
      const group = { index: rows.length, members: [record], proposed: record.type === "tool.proposed" ? record : undefined, result: undefined };
      openTools.set(key, group);
      rows.push(cachedRow(record, group.members,
        () => ({ kind: "tool", proposalKey: key, members: [record], proposed: group.proposed, result: undefined })));
      previous = undefined;
      continue;
    }
    pushOrRepeat(record);
  }
  return rows;
}

export function rowKey(row: LogRowModel): string {
  const first = row.kind === "tool" ? row.members[0] : row.kind === "repeat" ? row.record : row.record;
  return `${row.kind}-${first!.streamSeq}-${first!.eventId}`;
}

/** Worst severity across a row's records, for the leading dot. */
export function rowSeverity(row: LogRowModel): string | null {
  const order = ["debug", "info", "warning", "error", "critical"];
  let worst: string | null = null;
  for (const record of rowMembers(row)) {
    const rank = record.severity ? order.indexOf(record.severity) : -1;
    if (rank >= 0 && (worst === null || rank > order.indexOf(worst))) worst = record.severity;
  }
  return worst;
}

function rowMembers(row: LogRowModel): readonly LogRecord[] {
  return row.kind === "tool" || row.kind === "repeat" || row.kind === "message" ? row.members : [row.record];
}

function timeOfDay(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : at;
}

/** Time-of-day for the Readable mode; absolute ISO time in the tooltip. */
function TimeCell(props: { at: string; wide?: boolean }): JSX.Element {
  return <span class={`brain-exec-log shrink-0 text-ink-gray-6 ${props.wide ? "w-28" : "w-16"}`} title={props.at}>{timeOfDay(props.at)}</span>;
}

/** The one fixed-height row renderer for both modes. */
export function LogRow(props: {
  row: LogRowModel;
  mode: "readable" | "raw";
  selected: boolean;
  onSelect: (row: LogRowModel) => void;
}): JSX.Element {
  const record = () => (props.row.kind === "tool" ? props.row.proposed ?? props.row.members[0]! : props.row.record);
  const tool = () => (props.row.kind === "tool" ? props.row : undefined);
  const repeat = () => (props.row.kind === "repeat" ? props.row : undefined);
  const message = () => (props.row.kind === "message" ? props.row.text.replace(/\s+/gu, " ").trim() : undefined);
  const receipt = () => receiptOf(tool()?.result);
  return <button type="button" data-stream-seq={record().streamSeq} data-event-id={record().eventId}
    data-row-kind={props.row.kind} data-mode={props.mode}
    aria-pressed={props.selected}
    class={`flex h-full w-full items-center gap-2 border-b border-outline-gray-1 px-3 text-start focus-visible:focus-ring ${props.selected ? "bg-surface-blue-1" : "hover:bg-surface-gray-1"}`}
    onClick={() => props.onSelect(props.row)}>
    <Show when={props.mode === "readable"} fallback={<RawRowCells row={props.row} record={record()} />}>
      <span class={`size-2 shrink-0 rounded-full ${severityDotClass(rowSeverity(props.row))}`} role="img" aria-label={severityLabel(rowSeverity(props.row))} />
      <TimeCell at={record().at} />
      <Show when={tool()} fallback={
        <span class="brain-exec-log hidden w-20 shrink-0 truncate text-ink-gray-6 md:block" title={`emitter: ${record().emitter} · source: ${record().source ?? "frame"}`}>{record().emitter}</span>
      }>
        <span class="lucide-wrench size-3.5 shrink-0 text-ink-blue-8" aria-hidden="true" />
      </Show>
      <span class="brain-exec-log hidden w-44 shrink-0 truncate text-ink-gray-8 md:block" title={record().type}>
        {tool() ? toolIdentity(tool()!.proposed ?? tool()!.members[0]) : record().type}
      </span>
      <span class="brain-exec-log min-w-0 flex-1 truncate text-ink-gray-9">
        {tool() ?
          <span class={`truncate ${receipt()?.result === "failed" ? "text-ink-red-8" : ""}`}>
            {streamSummaryText(record().summary)}
            <Show when={!tool()!.result}><span class="ms-2 text-ink-amber-8">no result yet</span></Show>
          </span>
          : message() !== undefined ? streamSummaryText(message(), 400) : streamSummaryText(record().summary)}
      </span>
      <Show when={repeat()}><span class="shrink-0 rounded-control bg-surface-gray-2 px-1.5 text-xs text-ink-gray-7" title={`${repeat()!.members.length} consecutive identical records`}>×{repeat()!.members.length}</span></Show>
      <Show when={tool()}><span class="shrink-0 text-xs text-ink-gray-6" title="Tool invocation duration">{receiptDuration(receipt())}</span></Show>
    </Show>
    <Show when={record().tsApproximate}><span class="shrink-0 text-xs text-ink-gray-6" title="The source event carried no timestamp; this time was set at projection">~</span></Show>
  </button>;
}

/** Raw mode cells: the original redacted record's own coordinates. */
function RawRowCells(props: { row: LogRowModel; record: LogRecord }): JSX.Element {
  const repeat = () => (props.row.kind === "repeat" ? props.row.members.length : undefined);
  const payloadRefKind = () => {
    const ref = props.record.payloadRef;
    if (ref && typeof ref === "object" && !Array.isArray(ref) && typeof (ref as Record<string, unknown>)["kind"] === "string") {
      return String((ref as Record<string, unknown>)["kind"]);
    }
    return undefined;
  };
  return <>
    <span class="brain-exec-log w-16 shrink-0 text-ink-gray-6 tabular-nums" title="stream_seq — the one global cursor">{props.record.streamSeq}</span>
    <TimeCell at={props.record.at} wide />
    <span class="brain-exec-log hidden w-20 shrink-0 truncate text-ink-gray-6 md:block" title={`severity: ${severityLabel(props.record.severity)}`}>{props.record.severity ?? "log"}</span>
    <span class="brain-exec-log hidden w-20 shrink-0 truncate text-ink-gray-6 md:block">{props.record.emitter}</span>
    <span class="brain-exec-log hidden w-44 shrink-0 truncate text-ink-gray-8 md:block" title={props.record.type}>{props.record.type}</span>
    <span class="brain-exec-log min-w-0 flex-1 truncate text-ink-gray-7" title={streamSummaryText(props.record.summary, 400)}>{streamSummaryText(props.record.summary)}</span>
    <Show when={payloadRefKind()}><span class="shrink-0 rounded-control bg-surface-gray-2 px-1.5 text-xs text-ink-gray-7" title="Where the full payload lives">{payloadRefKind()}</span></Show>
    <Show when={repeat()}><span class="shrink-0 rounded-control bg-surface-gray-2 px-1.5 text-xs text-ink-gray-7" title={`${repeat()} consecutive identical records`}>×{repeat()}</span></Show>
  </>;
}

/** The record list rendered for "surrounding context" beside a jumped failure. */
export function ContextLines(props: { records: readonly LogRecord[] }): JSX.Element {
  return <ul class="brain-exec-log m-0 list-none p-0 text-ink-gray-7">
    <For each={props.records}>{(record) => (
      <li class="flex items-baseline gap-2 border-b border-outline-gray-1 py-0.5">
        <span class="w-16 shrink-0 text-right text-ink-gray-6 tabular-nums" title={record.at}>{record.streamSeq}</span>
        <span class={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${severityDotClass(record.severity)}`} aria-hidden="true" />
        <span class="w-40 shrink-0 truncate" title={record.type}>{record.type}</span>
        <span class="min-w-0 flex-1 break-words">{streamSummaryText(record.summary, 300)}</span>
      </li>
    )}</For>
  </ul>;
}
