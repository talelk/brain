import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { TextInput } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import type { QueryResponse } from "@brain/contracts";
import { query } from "../../data/client";
import { t } from "../../i18n";
import { useApp } from "../app-context";
import { missionHref, missionOfPath, workItemHref } from "../mission-links";
import { paletteActions } from "../palette-actions";

type SearchItem = Extract<QueryResponse, { queryType: "search.global" }>["snapshot"]["items"][number];

export function GlobalSearchDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const navigate = useNavigate();
  const app = useApp();
  const location = useLocation();
  const [term, setTerm] = createSignal("");
  const [items, setItems] = createSignal<SearchItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  // The combobox echoes a chosen option's label into the query after the choice; each opening starts from an empty search.
  // That echo can land after the dialog closed, so the search is also emptied as it opens.
  createEffect(() => { void props.open; setTerm(""); });
  createEffect(() => {
    if (!props.open || term().trim().length < 2) { setItems([]); setError(""); setLoading(false); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void query<Extract<QueryResponse, { queryType: "search.global" }>>({ queryType: "search.global", search: term().trim(), limit: 30 }, controller.signal)
        .then((result) => setItems([...result.snapshot.items]))
        .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Search is unavailable"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  });
  function destination(item: SearchItem): string {
    // Workspace-free execution deep links keep the console one hop from any hit.
    if (item.category === "mission") return missionHref(item.workspaceId, item.resourceId);
    if (item.category === "workItem" && item.missionId) return workItemHref(item.workspaceId, item.missionId, item.resourceId);
    if (item.category === "run") return `/runs/${item.resourceId}`;
    if (item.category === "approval") return `/approvals/${item.resourceId}`;
    if (item.category === "session") return `/sessions/${item.resourceId}`;
    if (item.category === "artifact") return `/outputs/${item.resourceId}`;
    if (item.category === "agent") return `/studio/Agent?selected=${encodeURIComponent(item.resourceId)}`;
    if (item.category === "workflow") return `/plays/${encodeURIComponent(item.resourceId)}`;
    return "/";
  }
  // Actions come first: they are what a person types a verb for, and they need no round trip. A search term narrows them by label.
  const actions = () => {
    const needle = term().trim().toLowerCase();
    return paletteActions(app.workspaceId(), missionOfPath(location.pathname)).map((action) => ({
      action, label: action.viewKey ? t(action.labelKey, { tab: t(action.viewKey) }) : t(action.labelKey),
    })).filter((entry) => !needle || entry.label.toLowerCase().includes(needle));
  };
  const kind = (item: SearchItem): string => (item.category === "mission" ? t("palette.kind.mission") : item.category === "workItem" ? t("palette.kind.work-item") : item.category);
  // One list of rows, listed inside the dialog (a popup portalled out of a modal dialog cannot be clicked): actions, then results.
  const rows = (): Array<{ id: string; label: string; description: string; href: string }> => [
    ...actions().map((entry) => ({ id: `action:${entry.action.id}`, label: entry.label, description: t("palette.kind.action"), href: entry.action.href })),
    ...items().map((item) => ({ id: `${item.category}:${item.workspaceId}:${item.resourceId}`, label: item.title, description: `${kind(item)} · ${item.reason}`, href: destination(item) })),
  ];
  const [active, setActive] = createSignal(0);
  createEffect(() => { void term(); void items(); setActive(0); });
  const choose = (href: string | undefined): void => { if (href) { props.onOpenChange(false); void navigate(href); } };
  const onKeyDown = (event: KeyboardEvent): void => {
    const count = rows().length;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (count ? (index + 1) % count : 0)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (count ? (index - 1 + count) % count : 0)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(rows()[active()]?.href); }
  };
  return <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog.Content size="2xl" position="top" class="brain-search-dialog">
      <Dialog.Header class="mb-3">
        <Dialog.Title>{t("palette.title")}</Dialog.Title>
        <Dialog.Description>{t("palette.description")}</Dialog.Description>
      </Dialog.Header>
      <Show when={props.open}>
        <TextInput label={t("palette.label")} placeholder={t("palette.placeholder")} value={term()} autofocus
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={rows()[active()] ? `palette-row-${active()}` : undefined}
          onInput={(event) => setTerm(event.currentTarget.value)} onKeyDown={onKeyDown} />
        <Show when={error()}><p class="mt-2 text-interface text-ink-red-7" role="alert">{error()}</p></Show>
        <div id="palette-list" role="listbox" aria-label={t("palette.label")} class="mt-2 max-h-80 overflow-y-auto">
          <For each={rows()}>{(row, index) => <div id={`palette-row-${index()}`} role="option" tabIndex={-1} aria-selected={active() === index()}
            class="flex cursor-pointer items-center justify-between gap-3 rounded-control px-2 py-1.5 text-base text-ink-gray-8 aria-selected:bg-surface-gray-3"
            onMouseEnter={() => setActive(index())} onClick={() => choose(row.href)} onKeyDown={(event) => { if (event.key === "Enter") choose(row.href); }}>
            <span class="min-w-0 truncate">{row.label}</span><span class="shrink-0 text-caption text-ink-gray-6">{row.description}</span>
          </div>}</For>
          <Show when={rows().length === 0 && !loading()}><div role="status" class="px-2 py-1.5 text-base text-ink-gray-6">{term().trim().length < 2 ? t("palette.type-more") : t("palette.empty")}</div></Show>
          <Show when={loading()}><div role="status" class="px-2 py-1.5 text-base text-ink-gray-6">{t("palette.searching")}</div></Show>
        </div>
      </Show>
    </Dialog.Content>
  </Dialog.Root>;
}
