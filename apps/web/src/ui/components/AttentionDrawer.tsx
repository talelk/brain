import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import type { AttentionItem, NotificationEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { formatDateTime } from "../format";
import { missionHref } from "../mission-links";
import { QueueRow, WorkspaceSection } from "./Domain";

export const TIER_TONE: Record<number, "red" | "amber" | "blue" | "green" | "gray"> = { 1: "red", 2: "amber", 3: "blue", 4: "green", 5: "gray" };
const KIND_ICON: Record<AttentionItem["kind"], string> = {
  approval: "lucide-shield-check", "budget-pause": "lucide-wallet", "needs-attention": "lucide-octagon-alert",
  "plan-proposal": "lucide-list-tree", parked: "lucide-circle-pause", "verdict-ready": "lucide-badge-check", routed: "lucide-message-square-warning",
};

/** Where an attention item is acted on: the approval review or the mission view that owns it. */
export function attentionHref(item: AttentionItem): string {
  if (item.kind === "approval") return `/approvals/${item.resourceId}`;
  const tab = item.kind === "plan-proposal" || item.kind === "parked" || item.kind === "needs-attention" ? "plan" : item.kind === "routed" ? "live" : "brief";
  const href = missionHref(item.workspaceId, item.missionId ?? item.resourceId, tab);
  return item.kind === "plan-proposal" ? `${href}&proposal=${encodeURIComponent(item.resourceId)}` : href;
}

/** Ranked attention rows (fixed tiers, longest wait first); the same rows on Missions and in the drawer. */
export function AttentionRows(props: { items: readonly AttentionItem[]; onOpen: (item: AttentionItem) => void }): JSX.Element {
  return <section class="brain-queue" aria-label="Attention strip"><For each={props.items}>{(item) =>
    <QueueRow title={item.title} description={item.detail ?? `Waiting since ${formatDateTime(item.waitingSince)}`} icon={KIND_ICON[item.kind]} tone={TIER_TONE[item.tier] ?? "gray"}
      eyebrow={item.kind.replace("-", " ")} label={`${item.title}. Open`} trailing={<Badge variant="outline" theme={TIER_TONE[item.tier] ?? "gray"} label={`Tier ${item.tier}`} />}
      onClick={() => props.onOpen(item)} />}</For></section>;
}

/**
 * The header bell (#43: no inbox route). It counts what needs you across your
 * workspaces and opens a drawer with the ranked attention items and the recent
 * notification history; opening an item goes where it is acted on.
 */
export function AttentionDrawer(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const attention = createScopedRead<AttentionItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: AttentionItem[] }; asOf: string; sourceWatermark: number }>({ queryType: "attention.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
  const history = createScopedRead<NotificationEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId || !open()) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: NotificationEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "notifications.list", workspaceId: scope.workspaceId, limit: 20 }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const count = () => attention.state().data?.length ?? 0;
  const go = (href: string) => { setOpen(false); void navigate(href); };
  const toggle = (next: boolean) => { setOpen(next); if (next) { void attention.refresh({ force: true }); void history.refresh({ force: true }); } };
  return <>
    <Button variant="ghost" iconLeft="lucide-bell" aria-label={count() ? `Needs you: ${count()} items` : "Needs you: nothing waiting"} onClick={() => toggle(true)}>
      <Show when={count()}><span class="rounded-full bg-surface-red-2 px-1.5 text-caption font-medium tabular-nums text-ink-red-8">{count()}</span></Show>
    </Button>
    <Dialog.Root open={open()} onOpenChange={toggle}>
      <Dialog.Content size="lg" position="top">
        <Dialog.Header class="mb-3">
          <Dialog.Title>Needs you</Dialog.Title>
          <Dialog.Description>Across your workspaces: approvals first, then stopped missions, proposals and parked work, verdicts ready to close and routed findings.</Dialog.Description>
        </Dialog.Header>
        <div class="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <ScreenRegion state={attention.state()} onRetry={() => void attention.refresh({ force: true })} emptyTitle="Nothing needs you" emptyDescription="Missions are moving on their own. Brain notifies you when a person is needed.">
            <AttentionRows items={attention.state().data ?? []} onOpen={(item) => go(attentionHref(item))} />
          </ScreenRegion>
          <WorkspaceSection title="Recent notifications" description="What Brain sent you, newest first.">
            <ScreenRegion state={history.state()} onRetry={() => void history.refresh({ force: true })} emptyTitle="No notifications yet" emptyDescription="Only attention items notify you; progress never does.">
              <div class="brain-queue"><For each={history.state().data ?? []}>{(entry) => <QueueRow title={entry.title} description={`Sent ${formatDateTime(entry.sentAt)}${entry.pushed ? " · pushed" : ""}`} icon="lucide-bell"
                label={`${entry.title}. Open`} onClick={() => go(entry.missionId ? missionHref(entry.workspaceId, entry.missionId, "live") : `/w/${entry.workspaceId}/missions`)} />}</For></div>
            </ScreenRegion>
          </WorkspaceSection>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
