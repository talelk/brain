import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate } from "@solidjs/router";
import { useApp } from "./app-context";

/**
 * The default-landing rule: `/` consults the shared `live.status` read —
 * active sessions or runs open the Live console, everything else opens the
 * workspace's Missions. Deep links are never overridden: this component is
 * mounted only for the bare `/` route, and an unreachable gate falls back to
 * Missions instead of trapping the user on a spinner.
 */
export function LandingRedirect(): JSX.Element {
  const app = useApp();
  const live = app.useLiveStatus();
  const route = () => {
    if (!app.workspaceId()) return "/administration/workspaces";
    const missions = `/w/${app.workspaceId()}/missions`;
    const status = live.state();
    if (status.data) return status.data.defaultRoute === "live" ? `/w/${app.workspaceId()}/live` : missions;
    return status.status === "loading" ? undefined : missions;
  };
  return <Show when={route()} fallback={<main class="p-4"><p role="status" class="text-ink-gray-7">Opening Brain…</p></main>}>
    <Navigate href={route()!} />
  </Show>;
}
