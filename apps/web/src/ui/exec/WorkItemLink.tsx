import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { useApp } from "../app-context";
import { missionHref } from "../mission-links";

/**
 * A link to the mission that owns a work item (the board is gone, #43): the
 * work item's mission is resolved with `workItems.get` and the link opens its
 * Plan tab. Until it resolves, or when it cannot, the label renders as plain text.
 */
export function WorkItemLink(props: { workspaceId: string; workItemId: string; children: JSX.Element; class?: string }): JSX.Element {
  const app = useApp();
  const item = createScopedRead<{ missionId: string }>({
    scope: app.scope,
    resource: () => props.workItemId,
    load: async (scope, signal, resource) => {
      const loaded = await query<{ snapshot: { missionId: string }; asOf: string; sourceWatermark: number }>({ queryType: "workItems.get", workspaceId: scope.workspaceId, resourceId: resource! }, signal);
      return { snapshot: { missionId: loaded.snapshot.missionId }, asOf: loaded.asOf, sourceWatermark: loaded.sourceWatermark };
    },
  });
  return <Show when={item.state().data?.missionId} fallback={<span class={props.class}>{props.children}</span>}>
    {(missionId) => <A class={props.class} href={missionHref(props.workspaceId, missionId(), "plan")}>{props.children}</A>}
  </Show>;
}
