import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { WorkItem, WorkItemCandidate } from "@brain/contracts";
import { formatTokens, formatUsd } from "../format";
import { t, tOr } from "../../i18n";

/** How long a candidate took, in the two units a person reads: seconds under a minute, else minutes. */
export function durationText(ms: number | undefined): string {
  if (ms === undefined) return t("work.candidate.duration-none");
  if (ms < 60_000) return t("work.candidate.seconds", { n: Math.max(1, Math.round(ms / 1000)) });
  return t("work.candidate.minutes", { n: Math.round(ms / 60_000) });
}

const STATE_THEME: Record<WorkItemCandidate["state"], "gray" | "blue" | "green" | "red" | "amber"> = { waiting: "gray", running: "blue", succeeded: "green", failed: "red", cancelled: "gray" };
const VERDICT_THEME: Record<WorkItemCandidate["verdict"], "gray" | "green" | "amber"> = { verified: "green", "not-verified": "amber", pending: "gray" };

/**
 * A task's candidates side by side (#127, ADR 0064): who ran each, whether it finished, its own verdict, what it cost and how long it took.
 * A person keeps one; the others stay as compared outputs. Brain proposes the one verified candidate but never keeps it. Reading the outputs
 * side by side is the output compare view, which already shows two versions with their provenance.
 */
export function Candidates(props: { item: WorkItem; canKeep: boolean; busy: boolean; error?: string | undefined; onKeep: (runId: string) => void }): JSX.Element {
  const navigate = useNavigate();
  const view = () => props.item.candidates;
  const compare = createMemo(() => (view()?.items ?? []).filter((entry) => entry.outputVersionId));
  const [left, setLeft] = createSignal("");
  const [right, setRight] = createSignal("");
  const pick = (side: "left" | "right"): WorkItemCandidate | undefined => {
    const options = compare();
    return options.find((entry) => entry.runId === (side === "left" ? left() : right())) ?? options[side === "left" ? 0 : 1];
  };
  const options = () => compare().map((entry) => ({ value: entry.runId, label: entry.label }));
  const comparable = () => { const a = pick("left"), b = pick("right"); return a && b && a.runId !== b.runId && a.outputId === b.outputId ? { a, b } : undefined; };
  const reviewing = () => props.item.state === "review";
  const waiting = () => (view()?.items ?? []).some((entry) => entry.state === "waiting" || entry.state === "running");
  return <Show when={view()}>{(candidates) => <section class="flex flex-col gap-3 border-b border-outline-gray-1 pb-4" aria-label={t("work.candidates")} data-testid="work-candidates">
    <div class="flex flex-col gap-0.5">
      <h4 class="text-base-medium">{t("work.candidates")}</h4>
      <p class="text-caption text-ink-gray-6">{t("work.candidates-hint")}</p>
    </div>
    <Show when={waiting()}><p class="text-interface text-ink-gray-7" data-testid="work-candidates-waiting">{t("work.candidates-waiting")}</p></Show>
    <Show when={props.error}><Alert theme="amber" variant="outline" title={t("work.candidate.keep-refused")} description={props.error} /></Show>
    <ul class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("work.candidates")}>
      <For each={candidates().items}>{(entry) => <li class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 p-3" classList={{ "border-outline-blue-3 bg-surface-blue-1": entry.kept === true }} data-testid="work-candidate" data-candidate={entry.candidateId}>
        <div class="flex flex-wrap items-center gap-2"><span class="min-w-0 break-words text-interface font-medium text-ink-gray-9">{entry.label}</span>
          <Show when={entry.kept}><Badge theme="blue" label={t("work.candidate.kept")} /></Show>
          <Show when={entry.proposed && !entry.kept}><Badge theme="green" variant="outline" label={t("work.candidate.proposed")} /></Show></div>
        <div class="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" theme={STATE_THEME[entry.state]} label={tOr(`work.candidate.state.${entry.state}`, entry.state)} />
          <Badge variant="outline" theme={VERDICT_THEME[entry.verdict]} label={tOr(`work.candidate.verdict.${entry.verdict}`, entry.verdict)} />
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption text-ink-gray-7">
          <dt class="text-ink-gray-6">{t("work.candidate.cost")}</dt><dd class="text-end font-medium text-ink-gray-9" data-testid="work-candidate-cost">{formatUsd(entry.settledMicroUsd + entry.reservedMicroUsd)}</dd>
          <dt class="text-ink-gray-6">{t("work.candidate.tokens")}</dt><dd class="text-end font-medium text-ink-gray-9">{formatTokens(entry.tokensUsed)}</dd>
          <dt class="text-ink-gray-6">{t("work.candidate.duration")}</dt><dd class="text-end font-medium text-ink-gray-9" data-testid="work-candidate-duration">{durationText(entry.durationMs)}</dd>
        </dl>
        <Show when={entry.proposed && !entry.kept}><p class="text-caption text-ink-gray-7">{t("work.candidate.proposed-why")}</p></Show>
        <Show when={props.canKeep && reviewing() && entry.state === "succeeded" && !entry.kept}>
          <Button size="sm" variant={entry.proposed ? "solid" : "outline"} theme="blue" iconLeft="lucide-check" disabled={props.busy} aria-label={t("work.candidate.keep-label", { name: entry.label })} onClick={() => props.onKeep(entry.runId)}>{t("work.candidate.keep")}</Button>
        </Show>
      </li>}</For>
    </ul>
    <Show when={compare().length >= 2}><div class="flex flex-col gap-2" data-testid="work-candidates-compare">
      <p class="text-interface font-medium text-ink-gray-8">{t("work.candidates-compare")}</p>
      <div class="grid min-w-0 gap-3 sm:grid-cols-2">
        <Select label={t("work.candidates-compare-left")} value={pick("left")?.runId ?? null} options={options()} onValueChange={(value) => setLeft(value ?? "")} />
        <Select label={t("work.candidates-compare-right")} value={pick("right")?.runId ?? null} options={options()} onValueChange={(value) => setRight(value ?? "")} />
      </div>
      <div><Button size="sm" variant="outline" iconLeft="lucide-git-compare" disabled={!comparable()}
        onClick={() => { const pair = comparable(); if (pair) void navigate(`/outputs/${encodeURIComponent(pair.a.outputId ?? "")}/compare?left=${encodeURIComponent(pair.a.outputVersionId ?? "")}&right=${encodeURIComponent(pair.b.outputVersionId ?? "")}`); }}>{t("work.candidates-compare-button")}</Button></div>
    </div></Show>
    <Show when={candidates().keptRunId}><p class="text-caption text-ink-gray-6" data-testid="work-candidates-kept-note">{t("work.candidates-kept-note")}</p></Show>
  </section>}</Show>;
}
