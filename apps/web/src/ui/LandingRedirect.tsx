import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate } from "@solidjs/router";
import { useApp } from "./app-context";
import { blockingCount, createAttentionRead } from "./attention";

/**
 * The default-landing rule (#47): `/` opens Today when the decision queue is
 * non-empty or nothing is active, and the Live console when sessions are
 * active and the queue is empty. Deep links are never overridden: this
 * component is mounted only for the bare `/` route, and an unreachable gate
 * falls back to Today instead of trapping the user on a spinner.
 */
export function LandingRedirect(): JSX.Element {
  const app = useApp();
  const live = app.useLiveStatus();
  const attention = createAttentionRead();
  const route = () => {
    if (!app.workspaceId()) return "/administration/workspaces";
    const today = `/w/${app.workspaceId()}/today`;
    const status = live.state();
    const queue = attention.state();
    const loading = (state: { status: string; data?: unknown }) => state.status === "loading" && !state.data;
    if (loading(status) || loading(queue)) return undefined;
    const waiting = blockingCount(queue.data ?? []) > 0;
    return status.data?.defaultRoute === "live" && !waiting ? `/w/${app.workspaceId()}/live` : today;
  };
  return <Show when={route()} fallback={<main class="p-4"><p role="status" class="text-ink-gray-7">Opening Brain…</p></main>}>
    <Navigate href={route()!} />
  </Show>;
}
