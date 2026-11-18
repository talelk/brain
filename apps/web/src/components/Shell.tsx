import { createContext, createEffect, createMemo, createSignal, For, onCleanup, Show, useContext, type JSX, type Setter } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Avatar, Badge, Button, KeyboardShortcut } from "@talelk/newui-atoms";
import { Menu, type BreadcrumbItem } from "@talelk/newui-molecules";
import { CommandGroup, CommandItem, CommandPalette, SidebarItem, SidebarLabel, useSidebar } from "@talelk/newui-organisms";
import { AppShell } from "@talelk/newui-templates";
import { authClient } from "../data/auth-client";
import { connected, updatedAt } from "../data/live";
import type { WorkspaceSummary } from "@brain/contracts";
import { useSession } from "../data/session";
import { LOCALES, locale, setLocale, t, type Locale } from "../i18n";
import { ago } from "../lib/format";
import { setTheme, theme } from "../lib/theme";
import { Icon, NeedsCount } from "./bits";
import { PlatformBadge } from "./Share";

/** Two links of a chain: the mark of the app. */
export const Mark = (props: { class?: string }): JSX.Element => (
  <svg viewBox="0 0 28 28" class={props.class ?? "size-6"} fill="none" stroke="currentColor" stroke-width="3.2" aria-hidden="true">
    <rect x="3" y="3" width="11" height="17" rx="5.5" />
    <rect x="14" y="8" width="11" height="17" rx="5.5" />
  </svg>
);

/** What the top of a page says: its title, the way back, and its own actions. Each screen declares it with `<Head>`; the shell draws it. */
interface HeadState { readonly title: JSX.Element; readonly description?: JSX.Element; readonly breadcrumbs?: BreadcrumbItem[]; readonly actions?: JSX.Element }
const HeadContext = createContext<Setter<HeadState>>();
export function Head(props: HeadState & { text?: string }): JSX.Element {
  const set = useContext(HeadContext);
  /** Kept apart so a new title does not rebuild the actions: a dialog opened from one stays open. */
  const actions = createMemo(() => props.actions);
  createEffect(() => {
    set?.({ title: props.title, description: props.description, breadcrumbs: props.breadcrumbs, actions: actions() });
    document.title = props.text ? `${props.text} · Brain` : "Brain";
  });
  return null;
}

const THEMES = [["light", "theme.light"], ["dark", "theme.dark"], ["system", "theme.system"]] as const;
const COLLAPSED_KEY = "brain.sidebar";
const readCollapsed = (): boolean => { try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; } };
const writeCollapsed = (value: boolean): void => { try { localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); } catch { /* a per-browser convenience only */ } };

/** The workspace a page is in, from the address. */
export const slugOf = (pathname: string): string | undefined => /^\/w\/([^/]+)/u.exec(pathname)?.[1];

/** A workspace as a square with its initial; a dot says something there needs the person. */
function WorkspaceMark(props: { name: string; needs: number }): JSX.Element {
  const { collapsed } = useSidebar();
  return <Avatar size="md" shape="square" theme="violet" label={props.name} indicator={props.needs > 0 && collapsed() ? <span class="block size-full rounded-full bg-needs" /> : undefined} />;
}

function Nav(): JSX.Element {
  const session = useSession();
  const location = useLocation();
  const { collapsed } = useSidebar();
  const slug = (): string | undefined => slugOf(location.pathname);
  const here = (path: string): boolean => location.pathname === path || location.pathname === `${path}/`;
  const needs = (id: string): number => session.overview.data()?.workspaces.find((workspace) => workspace.id === id)?.needsYou ?? 0;
  const allWaiting = (): number => (session.overview.data()?.workspaces ?? []).reduce((sum, workspace) => sum + workspace.attemptsWaiting, 0);
  const updates = (id: string): number => session.overview.data()?.workspaces.find((workspace) => workspace.id === id)?.updates ?? 0;
  const active = (): readonly WorkspaceSummary[] => session.workspaces().filter((workspace) => workspace.status === "active");
  const groups = (): ReadonlyArray<{ label: "nav.workspaces.mine" | "nav.workspaces.shared" | "nav.workspaces.public"; list: readonly WorkspaceSummary[] }> => [
    { label: "nav.workspaces.mine", list: active().filter((workspace) => !workspace.viaPublic && workspace.role === "admin") },
    { label: "nav.workspaces.shared", list: active().filter((workspace) => !workspace.viaPublic && workspace.role !== "admin") },
    { label: "nav.workspaces.public", list: active().filter((workspace) => workspace.viaPublic) },
  ];
  const waiting = (id: string): number => session.overview.data()?.workspaces.find((workspace) => workspace.id === id)?.attemptsWaiting ?? 0;
  const sub: readonly { path: string; label: "nav.today" | "nav.tasks" | "nav.workspace" | "nav.schedules" | "nav.queue" | "nav.insights" | "nav.live"; icon: string }[] = [
    { path: "", label: "nav.today", icon: "lucide-sun" }, { path: "/tasks", label: "nav.tasks", icon: "lucide-list-checks" }, { path: "/queue", label: "nav.queue", icon: "lucide-list-ordered" }, { path: "/live", label: "nav.live", icon: "lucide-activity" }, { path: "/schedules", label: "nav.schedules", icon: "lucide-calendar-clock" }, { path: "/insights", label: "nav.insights", icon: "lucide-chart-no-axes-combined" }, { path: "/workspace", label: "nav.workspace", icon: "lucide-folder-cog" },
  ];
  return (
    <div class="flex flex-col gap-0.5">
      <SidebarItem route="/" icon="lucide-layout-dashboard" active={here("/")}>{t("nav.overview")}</SidebarItem>
      <SidebarItem route="/live" icon="lucide-activity" active={here("/live")}>{t("nav.live")}</SidebarItem>
      <SidebarItem route="/queue" icon="lucide-list-ordered" active={here("/queue")} suffix={allWaiting() > 0 ? <span class="rounded-full bg-surface-gray-3 px-1.5 text-[0.6875rem] font-semibold leading-[1.125rem] text-ink-gray-8 tabular-nums"><span class="sr-only">{t("queue.waiting")} </span>{allWaiting()}</span> : undefined}>{t("nav.queue")}</SidebarItem>
      <SidebarItem route="/schedules" icon="lucide-calendar-clock" active={here("/schedules")}>{t("nav.schedules")}</SidebarItem>
      <SidebarItem route="/insights" icon="lucide-chart-no-axes-combined" active={here("/insights")}>{t("nav.insights")}</SidebarItem>
      <For each={groups().filter((group) => group.list.length > 0)}>
        {(group) => (<>
      <div class="mt-3"><SidebarLabel divider>{t(group.label)}</SidebarLabel></div>
      <For each={group.list}>
        {(workspace) => (
          <>
            <SidebarItem route={`/w/${workspace.slug}`} label={workspace.name} active={slug() === workspace.slug && !location.pathname.slice(`/w/${workspace.slug}`.length).replace(/^\//u, "")}
              prefix={<span aria-hidden="true"><WorkspaceMark name={workspace.name} needs={needs(workspace.id)} /></span>} suffix={<NeedsCount n={needs(workspace.id)} />}>
              {workspace.name}<Show when={workspace.platform}> <PlatformBadge /></Show><Show when={updates(workspace.id) > 0}> <Badge theme="amber" size="sm" label={t("packs.update.badge")} /></Show>
            </SidebarItem>
            <Show when={slug() === workspace.slug && !collapsed()}>
              <div class="ms-3.5 mb-1 flex flex-col gap-0.5 border-s border-outline-gray-1 ps-1.5">
                <For each={sub}>
                  {(item) => {
                    const href = `/w/${workspace.slug}${item.path}`;
                    return <SidebarItem route={href} icon={item.icon} active={item.path === "" ? here(href) : location.pathname === href || location.pathname.startsWith(`${href}/`)} suffix={item.path === "/queue" && waiting(workspace.id) > 0 ? <span class="rounded-full bg-surface-gray-3 px-1.5 text-[0.6875rem] font-semibold leading-[1.125rem] text-ink-gray-8 tabular-nums"><span class="sr-only">{t("queue.waiting")} </span>{waiting(workspace.id)}</span> : undefined}>{t(item.label)}</SidebarItem>;
                  }}
                </For>
              </div>
            </Show>
          </>
        )}
      </For>
        </>)}
      </For>
      <Show when={session.user().instanceAdmin}><SidebarItem route="/new" icon="lucide-plus" active={here("/new")}>{t("nav.newWorkspace")}</SidebarItem></Show>
      <Show when={session.user().instanceAdmin}><div class="mt-3"><SidebarLabel divider>{t("nav.instance")}</SidebarLabel></div><SidebarItem route="/users" icon="lucide-users-round" active={here("/users")}>{t("nav.users")}</SidebarItem></Show>
    </div>
  );
}


/** Health and People belong to a workspace: the one the person is in, else the one they were last in, else the first. */
function Footer(): JSX.Element {
  const session = useSession();
  const location = useLocation();
  const target = (): string | undefined => {
    const active = session.workspaces().filter((workspace) => workspace.status === "active" && !workspace.viaPublic);
    return (active.find((workspace) => workspace.slug === slugOf(location.pathname)) ?? active.find((workspace) => workspace.slug === lastSlug()) ?? active[0])?.slug;
  };
  const link = (path: string, label: "nav.health" | "nav.people", icon: string): JSX.Element => (
    <Show when={target()}>{(slug) => <SidebarItem route={`/w/${slug()}${path}`} icon={icon} active={location.pathname === `/w/${slug()}${path}`}>{t(label)}</SidebarItem>}</Show>
  );
  return <>{link("/health", "nav.health", "lucide-heart-pulse")}{link("/people", "nav.people", "lucide-users")}</>;
}

const LAST_KEY = "brain.workspace";
export const remember = (slug: string): void => { try { localStorage.setItem(LAST_KEY, slug); } catch { /* a convenience only */ } };
export const lastSlug = (): string | null => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };

function Account(props: { compact?: boolean }): JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const select = (value: string): void => {
    const [kind, choice] = value.split(":");
    if (kind === "lang") setLocale(choice as Locale);
    else if (kind === "theme") setTheme(choice as "light" | "dark" | "system");
    else if (kind === "profile") navigate("/profile");
    else void authClient.signOut().finally(() => { session.refetch(); navigate("/"); });
  };
  const choice = (value: string, label: string, on: boolean): JSX.Element => (
    <Menu.Item value={value}><span class="flex-1">{label}</span><Show when={on}><Icon name="lucide-check" class="size-4 text-violet-text" /></Show></Menu.Item>
  );
  return (
    <Menu.Root onSelect={select}>
      <Menu.Trigger class="flex h-10 w-full items-center gap-2 rounded-control px-1.5 text-start hover:bg-surface-gray-3 focus-visible:focus-ring" aria-label={t("nav.account", { name: session.user().name })}>
        <Avatar size="lg" theme="gray" label={session.user().name} />
        <Show when={!props.compact}>
          <span class="min-w-0 flex-1"><span class="block truncate text-interface-medium text-ink-gray-9">{session.user().name}</span><span class="block truncate text-caption text-ink-gray-6">{session.user().email}</span></span>
          <Icon name="lucide-chevrons-up-down" class="size-3.5 text-ink-gray-5" />
        </Show>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item value="profile:"><Icon name="lucide-user-round" class="size-4" />{t("nav.profile")}</Menu.Item>
        <Menu.Separator />
        <Menu.ItemGroup>
          <Menu.Label>{t("nav.language")}</Menu.Label>
          <For each={LOCALES}>{(entry) => choice(`lang:${entry.id}`, entry.label, locale() === entry.id)}</For>
        </Menu.ItemGroup>
        <Menu.Separator />
        <Menu.ItemGroup>
          <Menu.Label>{t("nav.theme")}</Menu.Label>
          <For each={THEMES}>{([id, label]) => choice(`theme:${id}`, t(label), theme() === id)}</For>
        </Menu.ItemGroup>
        <Menu.Separator />
        <Menu.Item value="signout"><Icon name="lucide-log-out" class="size-4 rtl:rotate-180" />{t("nav.signOut")}</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/** Whether the page is current: the stream is open, and when a screen last had an answer. */
function Live(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 10_000);
  onCleanup(() => clearInterval(timer));
  return (
    <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-caption text-ink-gray-7" role="status">
      <span class={`size-2 rounded-full ${connected() ? "bg-ok-mark" : "bg-ink-gray-4"}`} aria-hidden="true" />
      <span>{connected() ? t("live.live") : t("live.offline")}</span>
      <span class="text-ink-gray-6 max-md:hidden">· {t("live.updated", { when: ago(updatedAt(), now()) })}</span>
    </span>
  );
}

/** Cmd-K: a workspace, a goal or a page, by name. Goals are those on screen somewhere: waiting, running, and the recent ones of the open workspace. */
function Palette(props: { open: boolean; onOpenChange: (open: boolean) => void; slug: string | undefined; recent: readonly { rootId: string; title: string; workspaceId: string }[] }): JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const go = (path: string) => (): void => { props.onOpenChange(false); navigate(path); };
  const slugById = (id: string): { slug: string; name: string } | undefined => session.workspaces().find((workspace) => workspace.id === id);
  const active = (): readonly { id: string; slug: string; name: string }[] => session.workspaces().filter((workspace) => workspace.status === "active");
  const current = (): { slug: string; name: string } | undefined => active().find((workspace) => workspace.slug === props.slug);
  const goals = createMemo(() => {
    const seen = new Set<string>();
    const out: { rootId: string; title: string; slug: string; name: string }[] = [];
    for (const goal of props.recent) {
      const place = slugById(goal.workspaceId);
      if (place && !seen.has(goal.rootId)) { seen.add(goal.rootId); out.push({ rootId: goal.rootId, title: goal.title, slug: place.slug, name: place.name }); }
    }
    return out;
  });
  const tabs = ["agents", "tools", "plays", "memory", "projects", "settings"] as const;
  return (
    <CommandPalette open={props.open} onOpenChange={props.onOpenChange} placeholder={t("palette.placeholder")} label={t("palette.label")} size="lg" empty={t("palette.empty")}>
      <CommandGroup label={t("palette.pages")}>
        <CommandItem value="overview" icon="lucide-layout-dashboard" onSelect={go("/")}>{t("nav.overview")}</CommandItem>
        <CommandItem value="live" keywords="live wall ambient flow activity" icon="lucide-activity" onSelect={go("/live")}>{t("nav.live")}</CommandItem>
        <CommandItem value="queue" keywords="queue waiting runners slots" icon="lucide-list-ordered" onSelect={go("/queue")}>{t("nav.queue")}</CommandItem>
        <CommandItem value="insights" keywords="insights heatmap analytics statistics cost time failures" icon="lucide-chart-no-axes-combined" onSelect={go("/insights")}>{t("nav.insights")}</CommandItem>
        <CommandItem value="schedules" keywords="schedules cron triggers" icon="lucide-calendar-clock" onSelect={go("/schedules")}>{t("nav.schedules")}</CommandItem>
        <Show when={session.user().instanceAdmin}><CommandItem value="new-workspace" icon="lucide-plus" onSelect={go("/new")}>{t("nav.newWorkspace")}</CommandItem></Show>
        <Show when={session.user().instanceAdmin}><CommandItem value="users" keywords="users people invite groups accounts" icon="lucide-users-round" onSelect={go("/users")}>{t("nav.users")}</CommandItem></Show>
        <CommandItem value="profile" keywords="profile account password sessions" icon="lucide-user-round" onSelect={go("/profile")}>{t("nav.profile")}</CommandItem>
      </CommandGroup>
      <Show when={current()}>
        {(place) => (
          <CommandGroup label={place().name}>
            <CommandItem value={`${place().slug}-today`} keywords={`today ${place().name}`} icon="lucide-sun" onSelect={go(`/w/${place().slug}`)}>{t("nav.today")}</CommandItem>
            <CommandItem value={`${place().slug}-tasks`} keywords={`tasks goals ${place().name}`} icon="lucide-list-checks" onSelect={go(`/w/${place().slug}/tasks`)}>{t("nav.tasks")}</CommandItem>
            <For each={tabs}>{(tab) => <CommandItem value={`${place().slug}-${tab}`} keywords={`workspace ${place().name}`} icon="lucide-folder-cog" onSelect={go(`/w/${place().slug}/workspace/${tab}`)}>{`${t("nav.workspace")}: ${t(`workspace.tab.${tab}`)}`}</CommandItem>}</For>
            <CommandItem value={`${place().slug}-people`} keywords={`people secrets members ${place().name}`} icon="lucide-users" onSelect={go(`/w/${place().slug}/people`)}>{t("nav.people")}</CommandItem>
            <CommandItem value={`${place().slug}-health`} keywords={`health runners models audit ${place().name}`} icon="lucide-heart-pulse" onSelect={go(`/w/${place().slug}/health`)}>{t("nav.health")}</CommandItem>
          </CommandGroup>
        )}
      </Show>
      <CommandGroup label={t("nav.workspaces")}>
        <For each={active()}>{(workspace) => <CommandItem value={`ws-${workspace.slug}`} keywords={workspace.name} icon="lucide-folder-git-2" onSelect={go(`/w/${workspace.slug}`)}>{workspace.name}</CommandItem>}</For>
      </CommandGroup>
      <Show when={goals().length > 0}>
        <CommandGroup label={t("palette.goals")}>
          <For each={goals()}>{(goal) => <CommandItem value={`goal-${goal.rootId}`} keywords={goal.name} icon="lucide-target" description={goal.name} onSelect={go(`/w/${goal.slug}/tasks/${goal.rootId}`)}>{goal.title}</CommandItem>}</For>
        </CommandGroup>
      </Show>
    </CommandPalette>
  );
}

/** The frame of every signed-in page: the sidebar, the top bar with search and the live indicator, and the page's own heading. */
export function Shell(props: { children: JSX.Element; recent: readonly { rootId: string; title: string; workspaceId: string }[] }): JSX.Element {
  const location = useLocation();
  const [head, setHead] = createSignal<HeadState>({ title: "" });
  const [collapsed, setCollapsed] = createSignal(readCollapsed());
  const [searching, setSearching] = createSignal(false);
  return (
    <HeadContext.Provider value={setHead}>
      <a class="skip-link" href="#app-shell-content">{t("shell.skip")}</a>
      <AppShell
        title={head().title} description={head().description} breadcrumbs={head().breadcrumbs} actions={head().actions} navLabel={t("nav.main")}
        brand={<a href="/" class="flex items-center gap-2 rounded-control px-1 py-1 text-ink-gray-9 focus-visible:focus-ring" aria-label={t("nav.home")}><Mark /><span class="font-display text-[1.125rem] font-semibold tracking-tight">Brain</span></a>}
        brandCollapsed={<a href="/" class="grid size-8 place-items-center rounded-control text-ink-gray-9 focus-visible:focus-ring" aria-label={t("nav.home")}><Mark /></a>}
        navigationContent={() => <Nav />} settings={() => <Footer />} account={<Account />} accountCollapsed={<Account compact />}
        collapsed={collapsed()} onCollapsedChange={(next) => { setCollapsed(next); writeCollapsed(next); }}
        headerActions={
          <>
            <Live />
            <Button variant="outline" size="md" iconLeft="lucide-search" aria-label={t("palette.open")} onClick={() => setSearching(true)} class="min-w-9 max-sm:[&>span:last-child]:sr-only">
              <span class="flex items-center gap-3"><span class="max-md:sr-only">{t("palette.search")}</span><span dir="ltr" class="max-md:hidden"><KeyboardShortcut combo="Mod+K" /></span></span>
            </Button>
          </>
        }>
        <div class="min-w-0" data-route={location.pathname}>{props.children}</div>
      </AppShell>
      <Palette open={searching()} onOpenChange={setSearching} slug={slugOf(location.pathname)} recent={props.recent} />
    </HeadContext.Provider>
  );
}
