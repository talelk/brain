import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, KeyValue } from "@talelk/newui-atoms";
import type { AttemptSummary } from "@brain/contracts";
import { jobQuery } from "../../data/governor";
import { streamCompareQuery } from "../../data/exec-logs";
import type { StreamCompareResult } from "../../data/exec-logs";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion, severityDotClass } from "../screen-region";
import { useApp } from "../app-context";
import { buildLogRows, rowSeverity } from "./LogRow";
import type { EntryRowModel } from "./LogRow";
import { failureJump } from "./errorJump";
import { recordOfView } from "./LogTail";

/**
 * Cross-attempt comparison for one job (T61): pick up to four attempts and
 * read their bounded log windows side by side, with each attempt's first
 * failure marked. Windows come from `stream.compare` (≤ 500 records per
 * attempt, server-clamped) — never from a second logs viewer client.
 */

const MAX_ATTEMPTS = 4;
/** Rows rendered per attempt column before "… N more records retained" cuts in. */
const RENDER_ROWS = 60;

function AttemptColumn(props: { comparison: StreamCompareResult; attemptId: string }): JSX.Element {
  const attempt = () => props.comparison.attempts.find((entry) => entry.attemptId === props.attemptId);
  const records = () => (attempt()?.items ?? []).map(recordOfView);
  const rows = (): readonly EntryRowModel[] => buildLogRows(records());
  const firstFailure = () => failureJump(rows());
  return <div class="min-w-0 flex-1 rounded-card border border-outline-gray-1 p-2" data-attempt-id={props.attemptId} data-testid="compare-attempt">
    <div class="flex items-center justify-between gap-2">
      <span class="text-base-medium text-ink-gray-9">Attempt {attempt()?.number ?? "—"}</span>
      <Badge size="sm" variant="outline" theme="gray" label={attempt()?.state ?? "unknown"} />
    </div>
    <p class="mt-0.5 text-caption text-ink-gray-6">{records().length} retained records</p>
    <Show when={firstFailure()}>
      <p class="mt-1 flex items-center gap-1.5 text-caption text-ink-red-8" data-testid="compare-failure">
        <span class="lucide-circle-alert size-3.5 shrink-0" aria-hidden="true" />
        first failure: {firstFailure()!.reason}
      </p>
    </Show>
    <ul class="brain-exec-log mt-2 list-none overflow-auto p-0 text-ink-gray-7" style={{ "max-height": "24rem" }}>
      <For each={rows().slice(0, RENDER_ROWS)}>{(row) => {
        const record = row.kind === "tool" ? row.proposed ?? row.members[0]! : row.record;
        const repeatCount = row.kind === "repeat" ? row.members.length : undefined;
        return <li class="flex items-baseline gap-2 border-b border-outline-gray-1 py-0.5">
          <span class="w-14 shrink-0 text-right text-ink-gray-6 tabular-nums">{record.streamSeq}</span>
          <span class={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${severityDotClass(rowSeverity(row))}`} aria-hidden="true" />
          <span class="min-w-0 flex-1 break-words">{record.type}
            <Show when={repeatCount !== undefined}><span class="ms-1 text-ink-gray-6">×{repeatCount}</span></Show>
            <Show when={row.kind === "tool"}><span class="ms-1 text-ink-gray-6">tool invocation</span></Show>
          </span>
        </li>;
      }}</For>
    </ul>
    <Show when={records().length > RENDER_ROWS}>
      <p class="mt-1 text-caption text-ink-gray-6">… {records().length - RENDER_ROWS} more records retained — open the attempt in Logs for the full window.</p>
    </Show>
  </div>;
}

export function AttemptCompare(props: { jobId: string; onOpenAttempt: (attemptId: string) => void }): JSX.Element {
  const app = useApp();
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const [comparison, setComparison] = createSignal<StreamCompareResult | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const attempts = createScopedRead<readonly AttemptSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await jobQuery(scope.workspaceId, props.jobId, signal);
      return { ...loaded, snapshot: loaded.snapshot.attempts };
    },
    isEmpty: (list) => list.length === 0,
  });

  const toggle = (attemptId: string): void => {
    setSelected((previous) => {
      if (previous.includes(attemptId)) return previous.filter((id) => id !== attemptId);
      if (previous.length >= MAX_ATTEMPTS) return previous;
      return [...previous, attemptId];
    });
  };

  const run = async (): Promise<void> => {
    if (selected().length === 0) return;
    setBusy(true);
    setError("");
    try {
      const loaded = await streamCompareQuery({ jobId: props.jobId, attemptIds: selected() }, undefined);
      setComparison(loaded.snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The comparison read could not complete.");
    } finally {
      setBusy(false);
    }
  };

  return <div class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-1 p-card-pad" data-testid="attempt-compare">
    <div class="min-w-0">
      <h2 class="break-all text-section text-ink-gray-9">Compare attempts of job {props.jobId}</h2>
      <p class="mt-1 text-interface text-ink-gray-6">Pick up to {MAX_ATTEMPTS} attempts; each column shows its bounded retained window with the first failed operation marked.</p>
    </div>
    <ScreenRegion state={attempts.state()} skeleton="rows"
      emptyTitle="No attempts found" emptyDescription="This job has no recorded attempts to compare."
      onRetry={() => void attempts.refresh({ force: true })}>
      <div class="flex flex-wrap items-center gap-2">
        <For each={attempts.state().data ?? []}>{(attempt) => (
          <Checkbox label={`Attempt ${attempt.number} (${attempt.state})`} checked={selected().includes(attempt.attemptId)}
            disabled={!selected().includes(attempt.attemptId) && selected().length >= MAX_ATTEMPTS}
            onCheckedChange={() => toggle(attempt.attemptId)} />
        )}</For>
        <Button size="sm" variant="solid" theme="blue" loading={busy()} disabled={selected().length === 0} onClick={() => void run()}>
          Compare ({selected().length})
        </Button>
        <Show when={selected().length > 0}>
          <Button size="sm" variant="ghost" theme="gray" onClick={() => props.onOpenAttempt(selected()[0]!)}>Open first selection in Logs</Button>
        </Show>
      </div>
      <Show when={error()}><p role="alert" class="text-base text-ink-red-8">{error()}</p></Show>
      <Show when={comparison()}>
        <div class="mt-3 flex flex-col gap-2">
          <KeyValue label="Job" value={<span class="brain-exec-log">{comparison()!.jobId}</span>} orientation="vertical" />
          <div class="flex flex-col gap-2 lg:flex-row">
            <For each={comparison()!.attempts}>{(attempt) => <AttemptColumn comparison={comparison()!} attemptId={attempt.attemptId} />}</For>
          </div>
        </div>
      </Show>
    </ScreenRegion>
  </div>;
}
