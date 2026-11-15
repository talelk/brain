import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { AutonomyFigure, AutonomySuggestion, AutonomySuggestions as AutonomySuggestionsView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { formatDateTime } from "../format";
import { agentHref, missionHref } from "../mission-links";
import { WorkspaceSection } from "./Domain";
import { ActionFeedback } from "./ActionFeedback";
import { t, type MessageKey } from "../../i18n";

type Outcome = { key: string; text: string; tone: "info" | "error"; at: number };
/**
 * The last decision's outcome, kept outside the component: a page that re-reads after the command (the Play page remounts its body when its
 * catalogue changes) must not lose the words that say what happened. It shows for a short while, for the same suggestions only.
 */
const [lastOutcome, setLastOutcome] = createSignal<Outcome | undefined>();
const OUTCOME_MS = 30_000;

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

const PRESET: Readonly<Record<string, MessageKey>> = { supervised: "work.ceiling.supervised", standard: "work.ceiling.standard", autonomous: "work.ceiling.autonomous", "ask each time": "autonomy.repeat.from", "confirm automatically": "autonomy.repeat.to" };
const label = (value: string): string => (PRESET[value] ? t(PRESET[value]!) : value);

const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;
/** The figure as a person reads it, with what it counts beside it: "100% (5 of 5)" or "5". */
function figureValue(figure: AutonomyFigure): string {
  if (figure.unit === "ratio") return figure.value === undefined ? t("autonomy.figure.none") : t("autonomy.figure.ratio", { percent: percent(figure.value), numerator: figure.numerator, denominator: figure.denominator ?? 0 });
  return String(figure.numerator);
}

function heading(suggestion: AutonomySuggestion): string {
  if (suggestion.kind === "repeat") return t("autonomy.heading.repeat", { title: suggestion.subjectTitle });
  if (suggestion.kind === "play") return t("autonomy.heading.play", { title: suggestion.subjectTitle, to: label(suggestion.to) });
  return t("autonomy.heading.mission", { title: suggestion.subjectTitle, to: label(suggestion.to) });
}

/** One suggestion with the figures it rests on, each beside its definition, and the evidence to open before deciding. */
function Suggestion(props: { suggestion: AutonomySuggestion; workspaceId: string; busy: boolean; onDecide: (kind: "accept" | "dismiss", suggestion: AutonomySuggestion) => void }): JSX.Element {
  const s = () => props.suggestion;
  return <article class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-testid="autonomy-suggestion" data-kind={s().kind} data-subject={s().subjectId}>
    <div class="flex min-w-0 flex-col gap-1">
      <h3 class="m-0 min-w-0 break-words text-interface font-medium text-ink-gray-9" data-testid="autonomy-heading">{heading(s())}</h3>
      <p class="m-0 text-caption text-ink-gray-7">{t("autonomy.change", { from: label(s().from), to: label(s().to) })} {t("autonomy.lead")}</p>
    </div>
    <ul class="m-0 grid min-w-0 list-none gap-2 p-0 sm:grid-cols-2" aria-label={t("autonomy.figures")}>
      <For each={s().figures}>{(figure) => <li class="flex min-w-0 flex-col gap-0.5 rounded-control bg-surface-gray-1 p-3" data-testid="autonomy-figure" data-figure={figure.id} data-met={figure.met ? "yes" : "no"}>
        <span class="text-caption font-medium text-ink-gray-7">{figure.label}</span>
        <span class="min-w-0 break-words text-interface tabular-nums text-ink-gray-9" data-testid="autonomy-figure-value">{figureValue(figure)}</span>
        <span class="text-caption text-ink-gray-7">{t("autonomy.figure.needs", { needed: figure.needed })}</span>
        <span class="text-caption text-ink-gray-7" data-testid="autonomy-figure-definition">{figure.definition}</span>
      </li>}</For>
    </ul>
    <p class="m-0 text-caption text-ink-gray-7" data-testid="autonomy-counted">{s().counted.windowOnly ? t("autonomy.counted.window", { days: s().window.days }) : t("autonomy.counted", { since: formatDateTime(s().counted.since), reason: s().counted.reason })} {s().counted.definition}</p>
    <div class="flex min-w-0 flex-col gap-1" data-testid="autonomy-evidence">
      <h4 class="m-0 text-caption font-medium text-ink-gray-7">{t("autonomy.evidence")}</h4>
      <div class="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption">
        <For each={s().evidence.agentIds}>{(agentId) => <A class="text-ink-blue-link underline focus-visible:focus-ring" href={agentHref(props.workspaceId, agentId)} data-testid="autonomy-evidence-agent">{t("autonomy.evidence.agent", { name: agentId })}</A>}</For>
        <A class="text-ink-blue-link underline focus-visible:focus-ring" href={`/w/${encodeURIComponent(props.workspaceId)}/quality/cases`} data-testid="autonomy-evidence-cases">{t("autonomy.evidence.cases", { count: s().evidence.evalCases, days: s().window.days })}</A>
        <Show when={s().kind !== "mission"}><For each={s().evidence.missionIds.slice(0, 5)}>{(missionId) => <A class="text-ink-blue-link underline focus-visible:focus-ring" href={missionHref(props.workspaceId, missionId)}>{t("autonomy.evidence.mission", { id: missionId.slice(-6) })}</A>}</For></Show>
      </div>
      <Show when={s().evidence.failureClasses.length > 0}><p class="m-0 text-caption text-ink-gray-7">{t("autonomy.evidence.failures", { list: s().evidence.failureClasses.map((entry) => `${entry.label} (${entry.count})`).join(", ") })}</p></Show>
    </div>
    <p class="m-0 text-caption font-medium text-ink-gray-8" data-testid="autonomy-effects">{t("autonomy.effects")}</p>
    <div class="flex flex-wrap gap-2">
      <Button variant="solid" theme="blue" disabled={props.busy} onClick={() => props.onDecide("accept", s())} data-testid="autonomy-accept">{t("autonomy.accept")}</Button>
      <Button variant="outline" disabled={props.busy} onClick={() => props.onDecide("dismiss", s())} data-testid="autonomy-dismiss">{t("autonomy.dismiss")}</Button>
    </div>
  </article>;
}

/**
 * Autonomy suggestions earned from a track record (#158, ADR 0074): the Governor works them out from existing records on every read and a person
 * accepts or dismisses each. It renders nothing when there is none, is never a notification or an attention item, and shows only on the Play page, the
 * mission page and the Quality page. `resourceId` narrows the read (`play:<id>`, `about:<missionId>`); without one it lists the workspace's.
 */
export function AutonomySuggestions(props: { resourceId?: string; onChanged?: () => void }): JSX.Element {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const key = () => props.resourceId ?? "workspace";
  const message = () => { const outcome = lastOutcome(); return outcome && outcome.key === key() && Date.now() - outcome.at < OUTCOME_MS ? outcome : undefined; };
  const setMessage = (entry: { text: string; tone: "info" | "error" } | undefined) => setLastOutcome(entry ? { ...entry, key: key(), at: Date.now() } : undefined);
  const read = createScopedRead<AutonomySuggestionsView>({
    scope: app.scope, resource: () => props.resourceId ?? "", live: true,
    load: async (scope, signal) => {
      const response = await query<Envelope<AutonomySuggestionsView>>({ queryType: "autonomy.suggestions", workspaceId: scope.workspaceId, ...(props.resourceId ? { resourceId: props.resourceId } : {}) } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  async function decide(kind: "accept" | "dismiss", suggestion: AutonomySuggestion): Promise<void> {
    if (busy()) return;
    setBusy(true); setMessage(undefined);
    try {
      const outcome = await app.run(kind === "accept" ? "autonomy.suggestion.accept" : "autonomy.suggestion.dismiss", { kind: suggestion.kind, subjectId: suggestion.subjectId });
      if (!outcome.accepted) throw new Error(outcome.detail);
      setMessage({ text: kind === "accept" ? t("autonomy.accepted", { title: suggestion.subjectTitle, to: label(suggestion.to) }) : t("autonomy.dismissed"), tone: "info" });
      await read.refresh({ force: true });
      props.onChanged?.();
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : t("autonomy.refused"), tone: "error" });
      await read.refresh({ force: true });
    } finally { setBusy(false); }
  }
  const items = () => read.state().data?.items ?? [];
  return <Show when={items().length > 0 || message()}>
    <WorkspaceSection title={t("autonomy.title")} description={t("autonomy.description")}>
      <div class="flex min-w-0 flex-col gap-3" data-testid="autonomy-suggestions">
        <For each={items()}>{(suggestion) => <Suggestion suggestion={suggestion} workspaceId={app.workspaceId()} busy={busy()} onDecide={(kind, picked) => void decide(kind, picked)} />}</For>
        <Show when={message()}>{(entry) => <ActionFeedback message={entry().text} tone={entry().tone} title={t("autonomy.refused.title")} />}</Show>
      </div>
    </WorkspaceSection>
  </Show>;
}
