import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { KIND_ICON, TIER_TONE, kindLabel } from "./DecisionCard";
import { t } from "../../i18n";
import { Dialog } from "@talelk/newui-molecules";
import type { AttentionItem, NotificationEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { blockingCount, type AttentionRead } from "../attention";
import { ScreenRegion } from "../screen-region";
import { formatDateTime } from "../format";
import { missionHref } from "../mission-links";
import { QueueRow, WorkspaceSection } from "./Domain";
/** Where an attention item is acted on: the approval review or the mission view that owns it. */
export function attentionHref(item: AttentionItem): string {
  if (item.kind === "approval") return `/approvals/${item.resourceId}`;
  // An evaluation waiting for a person opens its attestation page, whether or not a mission is behind it.
  if (item.kind === "attestation") return `/attestations/${encodeURIComponent(item.resourceId)}?w=${encodeURIComponent(item.workspaceId)}`;
  // "See result" opens the result: the mission's Outputs tab, which also links to the write-up in the Library. It used to open the Review inbox, scrolled into a long list.
  if (item.kind === "outcome-unknown" && !item.missionId) return `/runs/${encodeURIComponent(item.resourceId)}`;
  if (item.kind === "schedule-failed" && !item.missionId) return `/w/${encodeURIComponent(item.workspaceId)}/schedules`;
  const tab = item.kind === "result-ready" || item.kind === "sign-off" || item.kind === "verdict-ready" ? "outputs" : item.kind === "plan-proposal" || item.kind === "parked" || item.kind === "needs-attention" || item.kind === "outcome-unknown" ? "plan" : item.kind === "routed" || item.kind === "question" ? "live" : "brief";
  const href = missionHref(item.workspaceId, item.missionId ?? item.resourceId, tab);
  if (item.kind === "result-ready" && item.missionId && item.resourceId !== item.missionId) return `${href}&result=${encodeURIComponent(item.resourceId)}`;
  if (item.kind === "question") return `${href}&question=${encodeURIComponent(item.resourceId)}`;
  return item.kind === "plan-proposal" ? `${href}&proposal=${encodeURIComponent(item.resourceId)}` : href;
}

/** What the row's primary action says: two verbs for everything that needs a person (Decide, Retry), and See result for good news. */
export function attentionAction(item: AttentionItem): string {
  switch (item.kind) {
    case "result-ready": return t("decision.seeResult");
    case "sign-off": return t("decision.signOff.open");
    case "question": return t("decision.question.answer");
    case "attestation": return t("decision.attestation.open");
    case "parked": case "outcome-unknown": case "schedule-failed": return t("decision.retry");
    default: return t("decision.decide");
  }
}

/** "Result ready: X is verified and done" reads as a sentence about the work, so a result row shows just the work. */
export const resultName = (title: string): string => title.replace(/^Result ready:\s*/u, "").replace(/\s+is verified and done$/u, "");

/** Ranked attention rows (fixed tiers, longest wait first); the same rows on Missions and in the drawer. */
export function AttentionRows(props: { items: readonly AttentionItem[]; onOpen: (item: AttentionItem) => void }): JSX.Element {
  return <section class="brain-queue" aria-label={t("decision.queue")}><For each={props.items}>{(item) =>
    <QueueRow title={item.kind === "result-ready" ? resultName(item.title) : item.title} description={item.detail ?? (item.kind === "result-ready" ? t("decision.finished", { when: formatDateTime(item.waitingSince) }) : t("decision.waitingSince", { when: formatDateTime(item.waitingSince) }))} icon={KIND_ICON[item.kind]} tone={TIER_TONE[item.tier] ?? "gray"}
      eyebrow={kindLabel(item.kind)} label={`${item.title}. ${t("decision.open")}`} trailing={<>
        <Badge variant="outline" theme={TIER_TONE[item.tier] ?? "gray"} label={kindLabel(item.kind)} />
        <span class="inline-flex items-center gap-1 rounded-control bg-surface-blue-8 px-2.5 py-1 text-interface font-medium text-ink-base" aria-hidden="true">{attentionAction(item)}<span class="lucide-arrow-right size-3.5" /></span>
      </>}
      onClick={() => props.onOpen(item)} />}</For></section>;
}

/**
 * The header bell (#43: no inbox route). It counts what needs you across your
 * workspaces and opens a drawer with the ranked attention items and the recent
 * notification history; opening an item goes where it is acted on.
 */
export function AttentionDrawer(props: { attention: AttentionRead }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const attention = props.attention;
  const history = createScopedRead<NotificationEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId || !open()) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: NotificationEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "notifications.list", workspaceId: scope.workspaceId, limit: 20 }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const count = () => blockingCount(attention.state().data ?? []);
  const go = (href: string) => { setOpen(false); void navigate(href); };
  const toggle = (next: boolean) => { setOpen(next); if (next) { void attention.refresh({ force: true }); void history.refresh({ force: true }); } };
  return <>
    <Button variant="ghost" iconLeft="lucide-bell" aria-label={count() ? t("decision.bell.count", { n: count() }) : t("decision.bell.none")} onClick={() => toggle(true)}>
      <Show when={count()}><span class="rounded-full bg-surface-red-2 px-1.5 text-caption font-medium tabular-nums text-ink-red-8">{count() > 99 ? "99+" : count()}</span></Show>
    </Button>
    <Dialog.Root open={open()} onOpenChange={toggle}>
      <Dialog.Content size="lg" position="top">
        <Dialog.Header class="mb-3">
          <Dialog.Title>{t("decision.queue")}</Dialog.Title>
          <Dialog.Description>{t("decision.bell.description")}</Dialog.Description>
        </Dialog.Header>
        <div class="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <ScreenRegion state={attention.state()} onRetry={() => void attention.refresh({ force: true })} emptyTitle={t("decision.empty.title")} emptyDescription={t("decision.empty.description")}>
            <AttentionRows items={attention.state().data ?? []} onOpen={(item) => go(attentionHref(item))} />
          </ScreenRegion>
          <WorkspaceSection title={t("decision.notifications.title")} description={t("decision.notifications.description")}>
            <ScreenRegion state={history.state()} onRetry={() => void history.refresh({ force: true })} emptyTitle={t("decision.notifications.emptyTitle")} emptyDescription={t("decision.notifications.emptyDescription")}>
              <div class="brain-queue"><For each={history.state().data ?? []}>{(entry) => <QueueRow title={entry.title} description={`${t("decision.notifications.sent", { when: formatDateTime(entry.sentAt) })}${entry.pushed ? ` · ${t("decision.notifications.pushed")}` : ""}`} icon="lucide-bell"
                label={`${entry.title}. ${t("decision.open")}`} onClick={() => go(entry.itemId.startsWith("approval:") ? `/approvals/${entry.itemId.slice("approval:".length)}` : entry.missionId ? missionHref(entry.workspaceId, entry.missionId, "live") : `/w/${entry.workspaceId}/missions`)} />}</For></div>
            </ScreenRegion>
          </WorkspaceSection>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
