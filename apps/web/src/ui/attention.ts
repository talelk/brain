import type { AttentionItem } from "@brain/contracts";
import { useApp } from "./app-context";
import { createScopedRead } from "../data/screens";
import { query } from "../data/client";

/** The one attention read: the header bell and the Missions sidebar count both use it. */
export function createAttentionRead() {
  const app = useApp();
  return createScopedRead<AttentionItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: AttentionItem[] }; asOf: string; sourceWatermark: number }>({ queryType: "attention.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
}
export type AttentionRead = ReturnType<typeof createAttentionRead>;
