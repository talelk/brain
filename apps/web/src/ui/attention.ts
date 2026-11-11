import { onCleanup, onMount } from "solid-js";
import type { AttentionItem } from "@brain/contracts";
import { useApp } from "./app-context";
import { createScopedRead } from "../data/screens";
import { query } from "../data/client";

/** The one attention read: the header bell and the Missions sidebar count both use it. */
/** Fired after an inline decision, so every attention read (the bell, Today) re-reads at once. */
export const ATTENTION_CHANGED = "brain:attention-changed";

export function createAttentionRead() {
  const app = useApp();
  const read = createScopedRead<AttentionItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: AttentionItem[] }; asOf: string; sourceWatermark: number }>({ queryType: "attention.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
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
