import { onCleanup, onMount } from "solid-js";
import type { AttentionItem } from "@brain/contracts";
import { useApp } from "./app-context";

/** The one attention read: the header bell and the Missions sidebar count both use it. */
/** Fired after an inline decision, so every attention read (the bell, Today) re-reads at once. */
export const ATTENTION_CHANGED = "brain:attention-changed";

export function createAttentionRead() {
  const read = useApp().useAttention();
  onMount(() => {
    const again = () => void read.refresh({ force: true });
    window.addEventListener(ATTENTION_CHANGED, again);
    onCleanup(() => window.removeEventListener(ATTENTION_CHANGED, again));
  });
  return read;
}
export type AttentionRead = ReturnType<typeof createAttentionRead>;

/** The bell counts what needs a person; a ready result (tier 6) is shown but never counted as waiting. */
export function blockingCount(items: readonly AttentionItem[]): number {
  return items.filter((item) => item.kind !== "result-ready").length;
}

/**
 * One problem is shown once. A mission "needs attention: all remaining work is parked" restates the parked task
 * that explains it, so while that task's own card exists the mission-level row folds into it (review item 15).
 */
export function foldAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const explained = new Set(items.filter((item) => item.kind === "parked" && item.missionId).map((item) => item.missionId));
  return items.filter((item) => !(item.kind === "needs-attention" && explained.has(item.missionId ?? item.resourceId)));
}
