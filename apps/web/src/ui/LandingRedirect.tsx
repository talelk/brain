import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate } from "@solidjs/router";
import { useApp } from "./app-context";

/**
 * `/` always opens Today: its "Working now" strip and decision cards say what is running and what
 * needs a person, so no landing rule has to guess. Deep links are never overridden: this component
 * is mounted only for the bare `/` route.
 */
export function LandingRedirect(): JSX.Element {
  const app = useApp();
  const route = () => (app.workspaceId() ? `/w/${app.workspaceId()}/today` : "/administration/workspaces");
  return <Show when={route()}><Navigate href={route()} /></Show>;
}
