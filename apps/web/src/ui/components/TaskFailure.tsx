import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { formatTokens } from "../format";
import { t, intlLocale, type MessageKey } from "../../i18n";
import type { FailureClass, Remedy } from "../../data/engine";

const FAILURE_KEYS: Readonly<Record<FailureClass, MessageKey>> = {
  "missing-tool": "failure.class.missing-tool", "unmeetable-criterion": "failure.class.unmeetable-criterion", "model-slip": "failure.class.model-slip",
  "tool-outage": "failure.class.tool-outage", quota: "failure.class.quota", budget: "failure.class.budget", unclassified: "failure.class.unclassified",
};
const REMEDY_KEYS: Readonly<Record<Remedy, MessageKey>> = {
  "switch-way-of-working": "failure.remedy.switch-way-of-working", "stronger-model": "failure.remedy.stronger-model", "ask-one-question": "failure.remedy.ask-one-question",
  "wait-and-retry": "failure.remedy.wait-and-retry", "wait-for-quota": "failure.remedy.wait-for-quota", "park-budget": "failure.remedy.park-budget", retry: "failure.remedy.retry",
};
/** One plain sentence for a failure class (the Quality page and the task use the same words). */
export const failureSentence = (failureClass: FailureClass): string => t(FAILURE_KEYS[failureClass]);

/** A whole number in the interface language ("200 000" in French, "200,000" in English). */
export const wholeNumber = (n: number): string => new Intl.NumberFormat(intlLocale()).format(n);

/** Where a task stands against its spend cap, in tokens ("12k of 200k tokens used"). */
export const spendLine = (item: Pick<WorkItem, "tokensUsed" | "tokenCap">): string | undefined =>
  item.tokenCap === undefined || item.tokensUsed === undefined ? undefined : t("task.spend.used", { used: formatTokens(item.tokensUsed), cap: formatTokens(item.tokenCap) });

/** The one-click raise: double the cap. */
export const doubledCap = (item: Pick<WorkItem, "tokenCap">): number => (item.tokenCap ?? 200_000) * 2;

/** Why a task stopped, as one sentence, and the one thing that fixes it. Nothing here names an engine, a run or an attempt. */
export function TaskFailure(props: { item: WorkItem }): JSX.Element {
  return <Show when={props.item.failureClass}>{(failureClass) => <div class="flex min-w-0 flex-col gap-1 rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3 text-interface" data-task-failure={failureClass()}>
    <p class="m-0 break-words font-medium text-ink-gray-9" data-task-failure-sentence>{failureSentence(failureClass())}</p>
    <Show when={props.item.remedy}>{(remedy) => <p class="m-0 break-words text-ink-gray-8" data-task-failure-fix><span class="font-medium">{t("failure.fix")}:</span> {t(REMEDY_KEYS[remedy()])}</p>}</Show>
    <Show when={props.item.requiredTools?.length}><p class="m-0 break-words text-caption text-ink-gray-6">{t("task.tools.needs", { tools: (props.item.requiredTools ?? []).join(", ") })}</p></Show>
    <Show when={spendLine(props.item)}>{(line) => <p class="m-0 text-caption text-ink-gray-6" data-task-spend>{line()}</p>}</Show>
  </div>}</Show>;
}

/** Raise one task's spend cap. A task that parked for spending its allowance tries again as soon as the cap is higher. */
export function SpendCapRaise(props: { item: WorkItem; onRaised: () => void | Promise<void>; /** A card has room for one button; a task page gets the number field too. */ compact?: boolean; class?: string }): JSX.Element {
  const app = useApp();
  const [value, setValue] = createSignal(String(doubledCap(props.item)));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const target = () => Number.parseInt(value(), 10);
  async function raise(): Promise<void> {
    const next = props.compact ? doubledCap(props.item) : target();
    if (busy()) return;
    if (!Number.isSafeInteger(next) || next <= (props.item.tokenCap ?? 0)) { setError(t("task.spend.tooLow", { cap: wholeNumber(props.item.tokenCap ?? 0) })); return; }
    setBusy(true); setError("");
    try {
      const receipt = await app.run("workItem.spendCap.raise", { workItemId: props.item.workItemId, maxTokens: next });
      if (!receipt.accepted) throw new Error(receipt.detail);
      await props.onRaised();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("decision.refused")); } finally { setBusy(false); }
  }
  return <div class={`flex min-w-0 flex-col gap-2 ${props.class ?? ""}`} data-spend-cap-raise>
    <Show when={!props.compact}>
      <TextInput label={t("task.spend.newCap")} type="number" min={(props.item.tokenCap ?? 0) + 1} inputmode="numeric" value={value()} onInput={(event) => setValue(event.currentTarget.value)} description={t("task.spend.hint")} />
    </Show>
    <div><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-gauge" loading={busy()} disabled={busy() || !app.canDispatch()} onClick={() => void raise()}>
      {props.compact ? t("task.spend.raiseTo", { n: wholeNumber(doubledCap(props.item)) }) : t("task.spend.raise")}</Button></div>
    <Show when={error()}><p role="alert" class="m-0 text-caption text-ink-red-7">{error()}</p></Show>
  </div>;
}
