import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate } from "@solidjs/router";
import { useApp } from "./app-context";

/**
 * The default-landing rule: `/` consults the shared `live.status` read —
 * active sessions or runs open the Live console, everything else opens Today.
 * Deep links are never overridden: this component is mounted only for the bare
 * `/` route, and an unreachable gate falls back to Today instead of trapping
 * the user on a spinner.
 */
export function LandingRedirect(): JSX.Element {
  const app = useApp();
  const live = app.useLiveStatus();
  const route = () => {
    if (!app.workspaceId()) return "/today";
    const status = live.state();
    if (status.data) return status.data.defaultRoute === "live" ? `/w/${app.workspaceId()}/live` : "/today";
    return status.status === "loading" ? undefined : "/today";
  };
  return <Show when={route()} fallback={<main class="p-4"><p role="status" class="text-ink-gray-7">Opening Brain…</p></main>}>
    <Navigate href={route()!} />
  </Show>;
}
