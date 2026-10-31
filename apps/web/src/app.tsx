import { lazy, Show, onMount, onCleanup, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Navigate, Route, Router, useLocation, useNavigate, useParams } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import { Avatar, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dropdown, Toaster } from "@talelk/newui-molecules";
import { SidebarItem } from "@talelk/newui-organisms";
import type { AppSidebarGroup } from "@talelk/newui-organisms";
import { AppShell } from "@talelk/newui-templates";
import { AppProvider, useApp } from "./ui/app-context";
import { governor } from "./data/client";
import { Authentication, AuthenticatorEnrollment, InitialPasswordChange, InvitationAcceptancePage } from "./ui/components/Authentication";
import { ThemeToggle } from "./ui/components/ThemeToggle";
import { GlobalSearchDialog } from "./ui/components/GlobalSearch";
import { BrandMark } from "./ui/components/primitives";
import { PageHeaderProvider, usePageHeader } from "./ui/page-context";
import { PRIMARY_NAVIGATION, AREA_NAVIGATION, ROUTES } from "./routes/index.gen";

const PAGE_LOADERS = {
  AgentsPage: () => import('./routes/catalog').then((m) => ({ default: m.AgentsPage })),
  WorkflowsPage: () => import('./routes/catalog').then((m) => ({ default: m.WorkflowsPage })),
  TodayPage: () => import('./routes/pages/TodayPage'),
  BridgePage: () => import('./routes/pages/BridgePage'),
  WorkspaceOverviewPage: () => import('./routes/pages/WorkspaceOverviewPage'),
  BoardPage: () => import('./routes/pages/BoardPage'),
  PlansPage: () => import('./routes/pages/PlansPage'),
  SchedulesPage: () => import('./routes/pages/SchedulesPage'),
  ResourcesPage: () => import('./routes/pages/ResourcesPage'),
  IntegrationsPage: () => import('./routes/administration/IntegrationsPage'),
  StudioListPage: () => import('./ui/studio/StudioPages').then((module) => ({ default: module.StudioListPage })),
  StudioEditorPage: () => import('./ui/studio/StudioPages').then((module) => ({ default: module.StudioEditorPage })),
  DecisionsPage: () => import('./routes/pages/DecisionsPage'),
  RunsPage: () => import('./routes/pages/RunsPage'),
  RunnersPage: () => import('./routes/pages/RunnersPage'),
  ApprovalsPage: () => import('./routes/pages/ApprovalsPage'),
  ApprovalDetailPage: () => import('./routes/pages/ApprovalDetailPage'),
  JobDetailPage: () => import('./routes/pages/JobDetailPage'),
  RunnersDetailPage: () => import('./routes/pages/RunnerDetailPage'),
  SessionDetailPage: () => import('./routes/pages/SessionDetailPage'),
  SupportPage: () => import('./routes/pages/SupportPage'),
  TicketDetailPage: () => import('./routes/pages/TicketDetailPage'),
  SrePage: () => import('./routes/pages/SrePage'),
  IncidentDetailPage: () => import('./routes/pages/IncidentDetailPage'),
  DeliveryPage: () => import('./routes/pages/DeliveryPage'),
  KnowledgePage: () => import('./routes/pages/KnowledgePage'),
  ToolsPage: () => import('./routes/pages/ToolsPage'),
  SettingsPage: () => import('./routes/pages/SettingsPage'),
  TvSupportPage: () => import('./routes/pages/TvSupportPage'),
  TvSrePage: () => import('./routes/pages/TvSrePage'),
};
type PageKey = keyof typeof PAGE_LOADERS;
const page = (key: PageKey) => lazy(PAGE_LOADERS[key]);

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

function titleForLocation(pathname: string): string {
  const match = ROUTES.find((route) => new RegExp(`^${route.route.replace(/:id/gu, "[^/]+")}$`).test(pathname));
  return match?.title ?? "Today";
}

function areaForPath(pathname: string): string {
  const path = pathname.split("?")[0] ?? pathname;
  // The tool catalog lives in the administration chrome (AREA_NAVIGATION) even though its contract group is knowledge.
  if (path === "/tools") return "administration";
  const match = ROUTES.find((route) => new RegExp(`^${route.route.replace(/:id/gu, "[^/]+")}$`).test(path));
  if (!match) return "";
  return match.navigationGroup === "settings" ? "administration" : match.navigationGroup;
}

const PRIMARY_ICONS: Record<string, string> = {
  today: "lucide-inbox", work: "lucide-kanban-square", runs: "lucide-activity", approvals: "lucide-shield-check", knowledge: "lucide-book-open", administration: "lucide-settings",
};
const AREA_ICONS: Record<string, string> = {
  "/today": "lucide-inbox", "/bridge": "lucide-network", "/w/:id/overview": "lucide-layout-dashboard", "/w/:id/plans": "lucide-list-tree",
  "/w/:id/board": "lucide-kanban-square", "/w/:id/workflows": "lucide-play", "/w/:id/schedules": "lucide-calendar-clock",
  "/w/:id/resources": "lucide-files", "/w/:id/support": "lucide-headset", "/w/:id/sre": "lucide-siren", "/w/:id/delivery": "lucide-package-check",
  "/w/:id/decisions": "lucide-scale", "/settings?tab=setup": "lucide-wand-sparkles", "/settings?tab=security": "lucide-shield",
  "/administration/integrations": "lucide-plug", "/settings?tab=release": "lucide-git-branch", "/w/:id/agents": "lucide-bot",
  "/tools": "lucide-wrench", "/runners": "lucide-server", "/settings?tab=people": "lucide-users", "/settings?tab=invitations": "lucide-mail-plus",
  "/settings?tab=members": "lucide-key-round", "/settings?tab=policy": "lucide-shield-check", "/settings?tab=health": "lucide-heart-pulse",
};

function Navigation(): AppSidebarGroup[] {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const area = () => areaForPath(location.pathname);
  const href = (route: string) => route.replace(":id", app.workspaceId());
  const active = (route: string) => {
    const path = route.split("?")[0] ?? route;
    return new RegExp(`^${path.replace(/:id/gu, "[^/]+")}$`).test(location.pathname);
  };
  const primary = PRIMARY_NAVIGATION.filter((entry) => entry.id !== "administration" || app.canAdminister()).map((entry) => ({
    label: entry.label, icon: PRIMARY_ICONS[entry.id], active: areaForPath(href(entry.route)) === area(),
    onClick: () => void navigate(href(entry.route)),
  }));
  const primaryRoutes = new Set(PRIMARY_NAVIGATION.map((entry) => href(entry.route)));
  const contextual = (AREA_NAVIGATION[area()] ?? []).filter((entry) =>
    (!entry.adminOnly || app.canAdminister() || Boolean(entry.identityOnly && app.identity()?.actor.scopes.includes("identity:read"))) && (!entry.organizationOnly || Boolean(app.identity()?.actor.scopes.includes("config:activate"))) && (!entry.identityOnly || Boolean(app.identity()?.actor.scopes.includes("identity:read"))),
  ).filter((entry) => !primaryRoutes.has(href(entry.route))).map((entry) => ({
    label: entry.label, icon: AREA_ICONS[entry.route], active: active(entry.route), onClick: () => void navigate(href(entry.route)),
  }));
  return [
    { label: "Brain", items: primary },
    ...(contextual.length ? [{ label: area() === "administration" ? "Administration" : "Views", items: contextual }] : []),
  ];
}

function settingsRoute(app: ReturnType<typeof useApp>): string {
  return app.identity()?.actor.scopes.includes("config:activate") ? "/settings?tab=setup" : app.canAdminister() ? "/settings?tab=members" : "/settings?tab=security";
}

function AccountMenu(props: { compact?: boolean }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const name = () => app.identity()?.displayName ?? "Account";
  return <div data-testid="account-menu" data-keep-drawer class="flex min-w-0">
    <Dropdown class={props.compact ? "size-10 justify-center" : "w-full justify-start"} options={[
      { label: app.canAdminister() ? "Administration" : "Security & account", value: "settings", icon: "lucide-user-round-cog" },
      { label: `Signed in as ${name()}`, value: "identity", disabled: true },
      { label: "Sign out", value: "signout", danger: true, icon: "lucide-log-out" },
    ]} onSelect={(value) => {
      if (value === "settings") void navigate(settingsRoute(app));
      if (value === "signout") void app.signOut();
    }}>
      <span class="flex min-w-0 items-center gap-2">
        <Avatar size="xs" theme="blue" label={name()} />
        <span class={props.compact ? "sr-only" : "truncate"}>{name()}</span>
      </span>
    </Dropdown>
  </div>;
}

function ShellLayout(props: RouteSectionProps): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const header = usePageHeader();
  const [searchOpen, setSearchOpen] = createSignal(false);
  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", shortcut);
    onCleanup(() => window.removeEventListener("keydown", shortcut));
  });
  return <AppShell
    brand={<BrandMark />}
    brandCollapsed={<BrandMark collapsed />}
    title={header()?.title ?? titleForLocation(location.pathname)}
    description={header()?.description}
    breadcrumbs={header()?.breadcrumbs}
    actions={header()?.actions}
    mobileTitle={header()?.title ?? titleForLocation(location.pathname)}
    headerActions={<><Button size="lg" variant="ghost" iconLeft="lucide-search" aria-label="Search Brain (Control K)" onClick={() => setSearchOpen(true)}><span class="max-sm:hidden">Search</span></Button><ThemeToggle /></>}
    tenant={<div data-keep-drawer><Dropdown aria-label="Choose workspace" class="w-full justify-start" options={app.workspaceOptions().map((option) => ({ ...option, icon: "lucide-building-2" }))}
      onSelect={(value) => { if (value) { app.selectWorkspace(value); void navigate(`/w/${value}/overview`); } }}>
      <span class="flex min-w-0 items-center gap-2"><span class="lucide-building-2 size-4 shrink-0" aria-hidden="true" /><span class="truncate">{app.workspaceOptions().find((option) => option.value === app.workspaceId())?.label ?? "Choose workspace"}</span></span>
    </Dropdown></div>}
    tenantCollapsed={<span class="lucide-building-2 size-5" aria-hidden="true" />}
    navigation={Navigation()}
    settings={<SidebarItem label={app.canAdminister() ? "Administration" : "Account settings"} icon="lucide-settings" onClick={() => void navigate(settingsRoute(app))}>{app.canAdminister() ? "Administration" : "Account settings"}</SidebarItem>}
    account={<AccountMenu />} accountCollapsed={<AccountMenu compact />}
    navLabel="Brain navigation">
    <GlobalSearchDialog open={searchOpen()} onOpenChange={setSearchOpen} />
    <Show when={app.globalError()}><Alert theme="red" variant="outline" title="Brain needs attention" description={app.globalError()} /></Show>
    <Show when={!app.identity()?.recoveryRequired && !(app.identity()?.requireTwoFactor && !app.identity()?.totpEnrolled)}
      fallback={<AuthenticatorEnrollment recoveryRequired={app.identity()?.recoveryRequired ?? false} onEnrolled={() => app.reloadIdentity()} />}>
      <Show when={app.workspaceId()} fallback={<NoWorkspaceCard />}>{props.children}</Show>
    </Show>
  </AppShell>;
}

/** First-run path: an authenticated account with no workspace can create one. */
function NoWorkspaceCard(): JSX.Element {
  const app = useApp();
  const [workspaceId] = createSignal(`ws-${crypto.randomUUID()}`);
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
  return <Show when={app.canAdminister()} fallback={<section class="p-6"><h2 class="text-heading">No workspace access</h2><p>Ask your administrator to grant access to a workspace.</p></section>}><section aria-label="Create your first workspace" class="mx-auto mt-8 flex max-w-md flex-col gap-3 rounded-card border border-outline-gray-2 p-6">
    <h2 class="text-heading">Create your first workspace</h2>
    <p class="text-base text-ink-gray-7">This account can read no workspace yet. Create one to start dispatching work.</p>
    <TextInput label="Display name" value={slug()} onInput={(e) => setSlug(e.currentTarget.value)} required disabled={busy()} />
    <Show when={error()}><p role="alert" class="text-base text-ink-red-8">{error()}</p></Show>
    <Button size="lg" disabled={!valid() || busy()} loading={busy()} onClick={() => void create()}>Create workspace</Button>
  </section></Show>;
}

function RootLayout(props: RouteSectionProps): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const invitation = () => location.pathname.startsWith("/accept-invitation/");
  return <Show when={app.ready()} fallback={
    <main class="grid h-dvh place-items-center"><h1 class="text-heading">Keyrus Brain</h1><p role="status">Connecting to Governor…</p></main>}>
    <Show when={app.identity() || invitation()} fallback={<>
      <Show when={app.globalError()}><p role="alert" class="p-4">{app.globalError()}</p></Show>
      <Authentication setupRequired={app.setupRequired()} onAuthenticated={() => app.reloadIdentity()} />
    </>}>
      <Show when={!app.identity()?.passwordChangeRequired} fallback={<InitialPasswordChange onChanged={async () => { await app.reloadIdentity(); void navigate("/settings?tab=setup"); }} />}>{props.children}</Show>
    </Show>
  </Show>;
}

export function App(): JSX.Element {
  return <AppProvider><PageHeaderProvider>
    <Router root={RootLayout}>
    {/* TV kiosk: dedicated read-only entries, no app shell. */}
    <Route path="/tv/support" component={page("TvSupportPage")} />
    <Route path="/tv/sre" component={page("TvSrePage")} />
    <Route path="/accept-invitation/:id" component={InvitationAcceptancePage} />
    <Route path="/" component={ShellLayout}>
      <Route path="/" component={() => <Navigate href="/today" />} />
      <Route path="/today" component={page("TodayPage")} />
      <Route path="/bridge" component={page("BridgePage")} />
      <Route path="/w/:id/agents" component={workspacePage("AgentsPage")} />
      <Route path="/w/:id/workflows" component={workspacePage("WorkflowsPage")} />
      <Route path="/w/:id/overview" component={workspacePage("WorkspaceOverviewPage")} />
      <Route path="/w/:id/board" component={workspacePage("BoardPage")} />
      <Route path="/w/:id/plans" component={workspacePage("PlansPage")} />
      <Route path="/w/:id/schedules" component={workspacePage("SchedulesPage")} />
      <Route path="/w/:id/resources" component={workspacePage("ResourcesPage")} />
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
      <Route path="/administration/integrations" component={workspacePage("IntegrationsPage")} />
      <Route path="/studio/:kind" component={workspacePage("StudioListPage")} />
      <Route path="/studio/:kind/:draftId" component={workspacePage("StudioEditorPage")} />
      <Route path="*" component={() => <Navigate href="/today" />} />
    </Route>
    </Router>
    <Toaster />
  </PageHeaderProvider></AppProvider>;
}
