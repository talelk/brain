import { createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Combobox, Dialog } from "@talelk/newui-molecules";
import type { QueryResponse } from "@brain/contracts";
import { query } from "../../data/client";

type SearchItem = Extract<QueryResponse, { queryType: "search.global" }>["snapshot"]["items"][number];

export function GlobalSearchDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const navigate = useNavigate();
  const [term, setTerm] = createSignal("");
  const [items, setItems] = createSignal<SearchItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
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
    if (item.category === "run") return `/jobs/${item.resourceId}`;
    if (item.category === "approval") return `/approvals/${item.resourceId}`;
    if (item.category === "agent") return `/w/${item.workspaceId}/agents?selected=${encodeURIComponent(item.resourceId)}`;
    if (item.category === "workflow") return `/w/${item.workspaceId}/workflows?selected=${encodeURIComponent(item.resourceId)}`;
    return "/today";
  }
  return <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog.Content size="2xl" position="top">
      <Dialog.Header>
        <Dialog.Title>Find work anywhere</Dialog.Title>
        <Dialog.Description>Search only the workspaces and records you are authorized to read.</Dialog.Description>
      </Dialog.Header>
      <Combobox label="Search Brain" placeholder="Try a run, approval, Agent or Workflow" query={term()} onQueryChange={setTerm}
        filterable={false} loading={loading()} error={error() || undefined} emptyText={term().trim().length < 2 ? "Type at least two characters." : "No authorized records match."}
        options={items().map((item) => ({ value: `${item.category}:${item.workspaceId}:${item.resourceId}`, label: item.title, description: `${item.category} · ${item.workspaceId} · ${item.reason}` }))}
        onValueChange={(value) => {
          const item = items().find((candidate) => `${candidate.category}:${candidate.workspaceId}:${candidate.resourceId}` === value);
          if (item) { props.onOpenChange(false); setTerm(""); void navigate(destination(item)); }
        }} />
    </Dialog.Content>
  </Dialog.Root>;
}
