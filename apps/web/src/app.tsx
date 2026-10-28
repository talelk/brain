import { lazy, Show, onMount, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate, Route, Router, useLocation, useNavigate, useParams } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import { createMediaQuery } from "@talelk/newui-atoms";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Dropdown, Select } from "@talelk/newui-molecules";
import { AppShell } from "@talelk/newui-templates";
import type { AppSidebarGroup } from "@talelk/newui-organisms";
import { AppProvider, useApp } from "./ui/app-context";
import { governor } from "./data/client";
import { Authentication, AuthenticatorEnrollment } from "./ui/components/Authentication";
import { ThemeToggle } from "./ui/components/ThemeToggle";
import { PRIMARY_NAVIGATION, ROUTES } from "./routes/index.gen";

/**
 * The Brain web application (document 21 + `ui-screen-contracts.json`).
 *
 * Five primary areas — Today, Work, Runs, Approvals, Knowledge — generated from
 * the route contract; Settings lives in the account menu; the TV kiosk has its
 * own read-only entry routes outside the shell. Page compositions are route-lazy
 * so the initial shell stays inside the release budget.
 */

type PageKey = keyof (typeof import("./routes/pages"))["pages"];

const page = (key: PageKey) =>
  lazy(async () => {
    const module = await import("./routes/pages");
    const Component = module.pages[key];
    return { default: () => <Component /> };
  });

/** Syncs the route's :id workspace into the app context (deep links). */
function WorkspaceSync(props: { children: JSX.Element }): JSX.Element {
  const app = useApp();
  const params = useParams();
  onMount(() => { if (params.id && params.id !== app.workspaceId()) app.selectWorkspace(params.id); });
  return <Show when={!params.id || params.id === app.workspaceId()} fallback={<p role="status" class="p-4 text-ink-gray-7">Switching workspace…</p>}>
    {props.children}
  </Show>;
}

const workspacePage = (key: PageKey) => {
  const Page = page(key);
  return () => <WorkspaceSync><Page /></WorkspaceSync>;
};

/** The page title for the current location, from the generated route contract. */
function titleForLocation(pathname: string): string {
  const match = ROUTES.find((route) => {
    const pattern = new RegExp(`^${route.route.replace(/:id/gu, "[^/]+")}$`);
    return pattern.test(pathname);
  });
  return match?.title ?? "Today";
}

function PrimaryNav(): AppSidebarGroup[] {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceId = () => app.workspaceId();
  const href = (route: string) => route.replace(":id", workspaceId() || "");
  const active = (route: string) => {
    const pattern = new RegExp(`^${route.replace(/:id/gu, "[^/]+")}`);
    return pattern.test(location.pathname);
  };
  // Buttons with SPA navigation (no full reload); `route` would render anchors.
  const item = (label: string, route: string) => ({
    label, active: active(route), onClick: () => void navigate(href(route)),
  });
  return [
    { items: PRIMARY_NAVIGATION.map((entry) => item(entry.label, entry.route)) },
    {
      label: "Today",
      items: [item("Bridge", "/bridge")],
    },
    {
      label: "Workspace",
      items: [
        item("Overview", "/w/:id/overview"),
        item("Board", "/w/:id/board"),
        item("Decisions", "/w/:id/decisions"),
        item("Support", "/w/:id/support"),
        item("SRE", "/w/:id/sre"),
        item("Delivery", "/w/:id/delivery"),
      ],
    },
    {
      label: "Platform",
      items: [item("Runner fleet", "/runners"), item("Tool catalog", "/tools")],
    },
  ];
}

function AccountMenu(props: { compact?: boolean }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  return <div data-testid="account-menu" class="flex min-w-0">
    <Dropdown class="min-w-0 max-w-44" options={[
      { label: "Settings", value: "settings" },
      { label: `Signed in as ${app.identity()?.displayName ?? ""}`, value: "identity", disabled: true },
      { label: "Sign out", value: "signout", danger: true },
    ]} onSelect={(value) => {
      if (value === "settings") void navigate("/settings");
      if (value === "signout") void app.signOut();
    }}>
      <span class="truncate">{props.compact ? "Account" : app.identity()?.displayName ?? "Account"}</span>
    </Dropdown>
  </div>;
}

function ShellLayout(props: RouteSectionProps): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  // Below the shell's desktop breakpoint the sidebar becomes a drawer that
  // closes on any button press, so the account menu moves to the header bar.
  const narrow = createMediaQuery("(max-width: 1023px)");
  return <AppShell
    brand="Keyrus Brain"
    title={titleForLocation(location.pathname)}
    headerActions={<><Show when={narrow()}><AccountMenu compact /></Show><ThemeToggle /></>}
    tenant={<Select label="Workspace" options={app.workspaceOptions()} value={app.workspaceId() || null}
      onValueChange={(value) => { if (value) { app.selectWorkspace(value); void navigate(`/w/${value}/overview`); } }} />}
    navigation={PrimaryNav()}
    settings={<Button variant="ghost" onClick={() => void navigate("/settings")} class="min-h-11">Settings</Button>}
    account={<Show when={!narrow()}><AccountMenu /></Show>}
    navLabel="Brain navigation">
    <Show when={app.globalError()}><p role="alert" class="mb-field">{app.globalError()}</p></Show>
    <Show when={!app.identity()?.totpEnrolled}>
      <AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={() => app.reloadIdentity()} />
    </Show>
    <Show when={app.workspaceId()} fallback={<NoWorkspaceCard />}>
      {props.children}
    </Show>
  </AppShell>;
}

/** First-run path: an authenticated account with no workspace can create one. */
function NoWorkspaceCard(): JSX.Element {
  const app = useApp();
  const [workspaceId, setWorkspaceId] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const valid = () => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(workspaceId()) && slug().trim().length > 0;
  async function create() {
    if (!valid() || busy()) return;
    setBusy(true); setError("");
    try {
      await governor("/v1/setup/workspace", { workspaceId: workspaceId(), slug: slug().trim() });
      await app.reloadIdentity();
      app.selectWorkspace(workspaceId());
    } catch (e) { setError(e instanceof Error ? e.message : "Workspace creation failed."); } finally { setBusy(false); }
  }
  return <section aria-label="Create your first workspace" class="mx-auto mt-8 flex max-w-md flex-col gap-3 rounded-card border border-outline-gray-2 p-6">
    <h2 class="text-heading">Create your first workspace</h2>
    <p class="text-base text-ink-gray-7">This account can read no workspace yet. Create one to start dispatching work.</p>
    <TextInput label="Workspace ID" value={workspaceId()} onInput={(e) => setWorkspaceId(e.currentTarget.value)}
      description="Letters, digits, dash and underscore; up to 64 characters." required disabled={busy()} />
    <TextInput label="Display name" value={slug()} onInput={(e) => setSlug(e.currentTarget.value)} required disabled={busy()} />
    <Show when={error()}><p role="alert" class="text-base text-ink-red-8">{error()}</p></Show>
    <Button class="min-h-11" disabled={!valid() || busy()} loading={busy()} onClick={() => void create()}>Create workspace</Button>
  </section>;
}

function RootLayout(props: RouteSectionProps): JSX.Element {
  const app = useApp();
  return <Show when={app.ready()} fallback={
    <main class="grid h-dvh place-items-center"><h1 class="text-heading">Keyrus Brain</h1><p role="status">Connecting to Governor…</p></main>}>
    <Show when={app.identity()} fallback={<>
      <Show when={app.globalError()}><p role="alert" class="p-4">{app.globalError()}</p></Show>
      <Authentication setupRequired={app.setupRequired()} onAuthenticated={() => app.reloadIdentity()} />
    </>}>
      {props.children}
    </Show>
  </Show>;
}

export function App(): JSX.Element {
  return <AppProvider>
    <Router root={RootLayout}>
    {/* TV kiosk: dedicated read-only entries, no app shell. */}
    <Route path="/tv/support" component={page("TvSupportPage")} />
    <Route path="/tv/sre" component={page("TvSrePage")} />
    <Route path="/" component={ShellLayout}>
      <Route path="/" component={() => <Navigate href="/today" />} />
      <Route path="/today" component={page("TodayPage")} />
      <Route path="/bridge" component={page("BridgePage")} />
      <Route path="/w/:id/overview" component={workspacePage("WorkspaceOverviewPage")} />
      <Route path="/w/:id/board" component={workspacePage("BoardPage")} />
      <Route path="/w/:id/decisions" component={workspacePage("DecisionsPage")} />
      <Route path="/w/:id/runs" component={workspacePage("RunsPage")} />
      <Route path="/w/:id/support" component={workspacePage("SupportPage")} />
      <Route path="/w/:id/sre" component={workspacePage("SrePage")} />
      <Route path="/w/:id/delivery" component={workspacePage("DeliveryPage")} />
      <Route path="/w/:id/knowledge" component={workspacePage("KnowledgePage")} />
      <Route path="/approvals" component={page("ApprovalsPage")} />
      <Route path="/approvals/:id" component={page("ApprovalDetailPage")} />
      <Route path="/jobs/:id" component={page("JobDetailPage")} />
      <Route path="/runners" component={page("RunnersPage")} />
      <Route path="/runners/:id" component={page("RunnersDetailPage")} />
      <Route path="/sessions/:id" component={page("SessionDetailPage")} />
      <Route path="/tickets/:id" component={page("TicketDetailPage")} />
      <Route path="/incidents/:id" component={page("IncidentDetailPage")} />
      <Route path="/tools" component={workspacePage("ToolsPage")} />
      <Route path="/settings" component={workspacePage("SettingsPage")} />
      <Route path="*" component={() => <Navigate href="/today" />} />
    </Route>
    </Router>
  </AppProvider>;
}
