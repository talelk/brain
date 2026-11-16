import { For, Show, type JSX } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { Menu } from "@talelk/newui-molecules";
import { authClient } from "../data/auth-client";
import { usePlace, useSession } from "../data/session";
import { LOCALES, locale, setLocale, t, type Locale, type MessageKey } from "../i18n";
import { setTheme, theme } from "../lib/theme";
import { Icon } from "./bits";

/** Two links of a chain: the mark of the app. */
export const Mark = (props: { class?: string }): JSX.Element => (
  <svg viewBox="0 0 28 28" class={props.class ?? "size-7"} fill="none" stroke="currentColor" stroke-width="3.2" aria-hidden="true">
    <rect x="3" y="3" width="11" height="17" rx="5.5" />
    <rect x="14" y="8" width="11" height="17" rx="5.5" />
  </svg>
);

const NAV: readonly { path: string; label: MessageKey; icon: string; end?: boolean }[] = [
  { path: "", label: "nav.today", icon: "lucide-sun", end: true },
  { path: "/tasks", label: "nav.tasks", icon: "lucide-list-checks" },
  { path: "/workspace", label: "nav.workspace", icon: "lucide-folder-cog" },
  { path: "/health", label: "nav.health", icon: "lucide-heart-pulse" },
];
const THEMES = [["light", "theme.light"], ["dark", "theme.dark"], ["system", "theme.system"]] as const;

const menuPanel = "min-w-56 rounded-xl border border-rule bg-sheet p-1.5 shadow-popover";
const menuItem = "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 t-text text-ink data-[highlighted]:bg-lilac";
const menuLabel = "px-2.5 pb-1 pt-2 t-small text-ink-3";

/** The frame of every signed-in page: a slim bar with the workspace, four places and the account. */
export function Shell(props: { children: JSX.Element }): JSX.Element {
  const place = usePlace();
  const location = useLocation();
  const waiting = (): number => { const today = place.today.data(); return today ? today.needsYou.length + today.approvals.filter((approval) => !today.needsYou.some((task) => task.id === approval.taskId)).length : 0; };
  const active = (item: (typeof NAV)[number]): boolean => { const href = place.to(item.path); return item.end ? location.pathname === href || location.pathname === `${href}/` : location.pathname.startsWith(href); };
  const links = (compact: boolean): JSX.Element => (
    <For each={NAV}>
      {(item) => (
        <A href={place.to(item.path)} aria-current={active(item) ? "page" : undefined}
          class={compact
            ? "relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium text-ink-3 aria-[current=page]:text-ink"
            : "relative flex items-center gap-2 rounded-full px-3.5 py-1.5 t-text font-medium text-ink-2 hover:bg-lilac hover:text-ink aria-[current=page]:bg-lilac aria-[current=page]:text-ink"}>
          <Show when={compact}><Icon name={item.icon} class="size-5" /></Show>
          {t(item.label)}
          <Show when={item.end && waiting() > 0}>
            <span class={`rounded-full bg-needs px-1.5 text-[0.6875rem] font-semibold leading-[1.125rem] text-(--on-needs) ${compact ? "absolute end-[22%] top-1.5" : ""}`}><span class="sr-only">{t("nav.needsYou")} </span>{waiting()}</span>
          </Show>
        </A>
      )}
    </For>
  );
  return (
    <div class="min-h-dvh pb-20 md:pb-0">
      <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-top focus:rounded-lg focus:bg-sheet focus:px-3 focus:py-2">{t("nav.skip")}</a>
      <header class="sticky top-0 z-raised border-b border-rule bg-paper">
        <div class="mx-auto flex h-14 max-w-[86rem] items-center gap-2 px-4 md:gap-4 md:px-8">
          <A href={place.to()} class="flex items-center gap-2 rounded-lg text-ink" aria-label={t("nav.home")}>
            <Mark />
            <span class="font-display text-[1.1875rem] font-semibold tracking-tight max-sm:hidden">Brain</span>
          </A>
          <WorkspaceSwitcher />
          <nav class="ms-2 hidden items-center gap-1 md:flex" aria-label={t("nav.main")}>{links(false)}</nav>
          <div class="ms-auto"><AccountMenu /></div>
        </div>
      </header>
      <main id="main" class="mx-auto max-w-[86rem] px-4 py-8 md:px-8 md:py-10">{props.children}</main>
      <nav class="fixed inset-x-0 bottom-0 z-raised grid grid-cols-4 border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)] md:hidden" aria-label={t("nav.main")}>{links(true)}</nav>
    </div>
  );
}

function WorkspaceSwitcher(): JSX.Element {
  const session = useSession();
  const place = usePlace();
  const navigate = useNavigate();
  return (
    <Menu.Root onSelect={(value) => navigate(value === "new" ? "/new" : `/w/${value}`)}>
      <Menu.Trigger class="flex min-w-0 max-w-[13rem] items-center gap-1.5 rounded-full border border-rule-2 bg-sheet py-1.5 pe-2.5 ps-3.5 t-text font-medium text-ink hover:border-ink-3 data-[state=open]:border-ink-3" aria-label={t("nav.switch", { name: place.summary().name })}>
        <span class="truncate">{place.summary().name}</span>
        <Icon name="lucide-chevrons-up-down" class="size-3.5 text-ink-3" />
      </Menu.Trigger>
      <Menu.Content class={menuPanel}>
        <For each={session.workspaces().filter((workspace) => workspace.status === "active")}>
          {(workspace) => (
            <Menu.Item value={workspace.slug} class={menuItem}>
              <span class="min-w-0 flex-1 truncate">{workspace.name}</span>
              <Show when={workspace.id === place.id()}><Icon name="lucide-check" class="size-4 text-violet-text" /></Show>
            </Menu.Item>
          )}
        </For>
        <Show when={session.user().instanceAdmin}>
          <Menu.Separator class="my-1.5 border-rule" />
          <Menu.Item value="new" class={menuItem}><Icon name="lucide-plus" />{t("nav.newWorkspace")}</Menu.Item>
        </Show>
      </Menu.Content>
    </Menu.Root>
  );
}

function AccountMenu(): JSX.Element {
  const session = useSession();
  const place = usePlace();
  const navigate = useNavigate();
  const initials = (): string => session.user().name.split(/\s+/u).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();
  const select = (value: string): void => {
    const [kind, choice] = value.split(":");
    if (kind === "lang") setLocale(choice as Locale);
    else if (kind === "theme") setTheme(choice as "light" | "dark" | "system");
    else if (kind === "people") navigate(place.to("/people"));
    else void authClient.signOut().finally(() => { session.refetch(); navigate("/"); });
  };
  const choice = (value: string, label: string, on: boolean): JSX.Element => (
    <Menu.Item value={value} class={menuItem}><span class="flex-1">{label}</span><Show when={on}><Icon name="lucide-check" class="size-4 text-violet-text" /></Show></Menu.Item>
  );
  return (
    <Menu.Root onSelect={select}>
      <Menu.Trigger class="flex size-9 items-center justify-center rounded-full bg-ink text-[0.8125rem] font-semibold text-paper hover:bg-ink-2" aria-label={t("nav.account", { name: session.user().name })}>{initials()}</Menu.Trigger>
      <Menu.Content class={menuPanel}>
        <div class="px-2.5 pb-2 pt-1.5">
          <p class="t-text font-medium text-ink">{session.user().name}</p>
          <p class="t-small text-ink-3">{session.user().email}</p>
        </div>
        <Menu.Separator class="my-1 border-rule" />
        <Menu.ItemGroup>
          <Menu.Label class={menuLabel}>{t("nav.language")}</Menu.Label>
          <For each={LOCALES}>{(entry) => choice(`lang:${entry.id}`, entry.label, locale() === entry.id)}</For>
        </Menu.ItemGroup>
        <Menu.ItemGroup>
          <Menu.Label class={menuLabel}>{t("nav.theme")}</Menu.Label>
          <For each={THEMES}>{([id, label]) => choice(`theme:${id}`, t(label), theme() === id)}</For>
        </Menu.ItemGroup>
        <Menu.Separator class="my-1.5 border-rule" />
        <Menu.Item value="people" class={menuItem}><Icon name="lucide-users" />{t("nav.people")}</Menu.Item>
        <Menu.Item value="signout" class={menuItem}><Icon name="lucide-log-out" class="size-4 rtl:rotate-180" />{t("nav.signOut")}</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
