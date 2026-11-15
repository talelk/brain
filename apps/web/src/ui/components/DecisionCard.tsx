import { Show } from "solid-js";
import type { JSX } from "solid-js";
import type { AttentionItem } from "@brain/contracts";
import { IconTile } from "./primitives";
import { t, type MessageKey } from "../../i18n";

/** Icon and tone per kind of thing that needs a person; the one map for the card, the bell and the Missions list. */
export const KIND_ICON: Record<AttentionItem["kind"], string> = {
  approval: "lucide-shield-check", "budget-pause": "lucide-wallet", "needs-attention": "lucide-octagon-alert",
  "plan-proposal": "lucide-list-tree", parked: "lucide-circle-pause", "sign-off": "lucide-pen-line", "verdict-ready": "lucide-badge-check", routed: "lucide-message-square-warning",
  "result-ready": "lucide-circle-check-big", "schedule-failed": "lucide-calendar-x", "outcome-unknown": "lucide-circle-help",
};
export const TIER_TONE: Record<number, "red" | "amber" | "blue" | "green" | "gray"> = { 1: "red", 2: "amber", 3: "blue", 4: "green", 5: "gray", 6: "green" };

const KIND_KEYS: Readonly<Record<AttentionItem["kind"], MessageKey>> = {
  approval: "decision.kind.approval", "budget-pause": "decision.kind.budget-pause", "needs-attention": "decision.kind.needs-attention", "plan-proposal": "decision.kind.plan-proposal",
  parked: "decision.kind.parked", "sign-off": "decision.kind.sign-off", "verdict-ready": "decision.kind.verdict-ready", routed: "decision.kind.routed", "result-ready": "decision.kind.result-ready",
  "schedule-failed": "decision.kind.schedule-failed", "outcome-unknown": "decision.kind.outcome-unknown",
};
/** The plain name of what is waiting ("Plan", "Approval", "Stopped task"). */
export const kindLabel = (kind: AttentionItem["kind"]): string => t(KIND_KEYS[kind]);

/**
 * The one decision card (phase 2): everything that needs a person has the same four parts, in the
 * same order. What happened (the title), why (the cause in plain words), the recommended action
 * (one primary button) and the other options (everything else, including the way to the details).
 * Plan proposals, approvals, stopped tasks, budget pauses, unknown outcomes and verdicts all render
 * through this component, so a person learns the shape once.
 */
export function DecisionCard(props: {
  kind: AttentionItem["kind"];
  tier: number;
  /** What happened, as a sentence about the work. */
  title: string;
  /** Why it needs a person. */
  why?: string | undefined;
  /** Extra read-only content between the cause and the actions (the exact proposal, a plan summary, an estimate). */
  children?: JSX.Element;
  /** The one recommended action; the primary button. */
  recommended?: JSX.Element;
  /** The other things a person can do, and the way to the full details. */
  alternatives?: JSX.Element;
  /** An error from the last attempt, announced where it happened. */
  error?: string | undefined;
}): JSX.Element {
  return <article class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 p-3 sm:p-4" data-testid="needs-you-item" data-kind={props.kind} data-decision-card>
    <div class="flex min-w-0 items-start gap-3">
      <IconTile icon={KIND_ICON[props.kind]} tone={TIER_TONE[props.tier] ?? "gray"} />
      <div class="min-w-0 flex-1">
        <p class="m-0 text-caption font-medium uppercase tracking-wide text-ink-gray-6">{kindLabel(props.kind)}</p>
        <h3 class="m-0 break-words text-base-medium text-ink-gray-9">{props.title}</h3>
        <Show when={props.why}><p class="m-0 mt-0.5 break-words text-interface text-ink-gray-7"><span class="sr-only">{t("decision.why")}: </span>{props.why}</p></Show>
      </div>
    </div>
    <div class="brain-needs-actions flex min-w-0 flex-col gap-2 ps-0 sm:ps-[3.25rem]">
      {props.children}
      <Show when={props.recommended || props.alternatives}>
        <fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
          <legend class="sr-only">{t("decision.actions")}</legend>
          <Show when={props.recommended}><span class="contents" data-decision-slot="recommended">{props.recommended}</span></Show>
          <Show when={props.alternatives}><span class="contents" data-decision-slot="alternatives">{props.alternatives}</span></Show>
        </fieldset>
      </Show>
      <Show when={props.error}><p role="alert" class="text-caption text-ink-red-7">{props.error}</p></Show>
    </div>
  </article>;
}
