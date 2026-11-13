import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate, useLocation } from "@solidjs/router";
import { useApp } from "./app-context";

/** The Administration landing: the first Administration page this person can open (Setup, else Access, else Security). */
export function administrationLanding(app: Pick<ReturnType<typeof useApp>, "identity" | "canAdminister">): string {
  return app.identity()?.actor.scopes.includes("config:activate") ? "/settings?tab=setup" : app.canAdminister() ? "/settings?tab=members" : "/settings?tab=security";
}

/** The `/settings?tab=` values the Administration page itself renders. */
const SETTINGS_TABS: ReadonlySet<string> = new Set(["setup", "security", "people", "invitations", "policy", "work", "health", "members", "release"]);
/** Administration pages with their own route, which an old or hand-typed `/settings?tab=` link may still name. */
const TAB_PAGES: Readonly<Record<string, string>> = { quality: "/quality", workspaces: "/administration/workspaces", integrations: "/administration/integrations", runners: "/runners" };

/**
 * `/settings` shows the tab it names. A tab that is a page of its own opens that page, and a tab nobody knows opens the
 * Administration landing, never another page's content under the wrong name.
 */
export function SettingsRoute(props: { children: JSX.Element }): JSX.Element {
  const app = useApp();
  const location = useLocation();
  const tab = () => new URLSearchParams(location.search).get("tab");
  const target = (): string | undefined => {
    const name = tab();
    if (name === null || SETTINGS_TABS.has(name)) return undefined;
    return TAB_PAGES[name] ?? administrationLanding(app);
  };
  return <Show when={target()} fallback={props.children}>{(href) => <Navigate href={href()} />}</Show>;
}

/** An unscoped link to a page of a workspace (`/library`) opens that page in the current workspace; the contract serves it at `/w/:id/<page>`. */
export function ToWorkspacePage(props: { page: string }): JSX.Element {
  const app = useApp();
  const location = useLocation();
  return <Show when={app.workspaceId()}>{(id) => <Navigate href={["/w", id(), props.page].join("/") + location.search + location.hash} />}</Show>;
}
