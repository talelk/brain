import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge } from "@talelk/newui-atoms";
import type { KnowledgeAsset } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { librarySummary, type LibrarySummary } from "../../data/library";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "./Domain";
import { LIST_PAGE_SIZE, Pager } from "./primitives";
import { formatDateTime, formatRelative } from "../format";
import { missionHref } from "../mission-links";
import { t, tn } from "../../i18n";

/** Markdown marks out, so an entry reads as plain words in a list. */
export function plainSnippet(content: string, limit = 220): string {
  const text = content.replace(/```[\s\S]*?```/gu, " ").replace(/[#>*_`|]/gu, "").replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** An entry's own title, else its first line. */
export function entryTitle(asset: Pick<KnowledgeAsset, "title" | "content">): string {
  return asset.title?.trim() || plainSnippet(asset.content.split("\n").find((line) => line.trim()) ?? "", 90) || "—";
}

/**
 * What Brain has learned, in plain words (phase 2): every published entry with where it was learned
 * (the mission it came from) and how often it helped. "Helped N times" and the expiry date come from the
 * engine; they appear only when the Governor reports them, so an entry never claims a number nobody counted.
 */
export function LearnedKnowledge(): JSX.Element {
  const app = useApp();
  const missions = app.useMissions();
  const [page, setPage] = createSignal(1);
  const assets = createScopedRead<KnowledgeAsset[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: KnowledgeAsset[] }; asOf: string; sourceWatermark: number }>({ queryType: "knowledgeAssets.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      const published = response.snapshot.items
        .filter((asset) => asset.state === "published" && !asset.supersededBy && !asset.rejectionReason)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { snapshot: published, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const summary = createScopedRead<LibrarySummary>({ scope: app.scope, load: async (scope, signal) => librarySummary(scope.workspaceId, signal) });
  const titles = createMemo(() => new Map((missions.state().data ?? []).map((mission) => [mission.missionId, mission.title] as const)));
  const items = () => assets.state().data ?? [];
  const total = () => summary.state().data?.publishedKnowledge ?? items().length;
  const currentPage = () => Math.min(page(), Math.max(1, Math.ceil(items().length / LIST_PAGE_SIZE)));
  const shown = () => items().slice((currentPage() - 1) * LIST_PAGE_SIZE, currentPage() * LIST_PAGE_SIZE);
  return <WorkspaceSection title={t("library.learned.title")} description={t("library.learned.description")}>
    <ScreenRegion state={assets.state()} onRetry={() => void assets.refresh({ force: true })} emptyTitle={t("library.learned.empty.title")} emptyDescription={t("library.learned.empty.description")}>
      <p class="m-0 mb-2 text-caption text-ink-gray-6" data-testid="learned-count">{tn("library.learned.count", total())}</p>
      <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="learned-list">
        <For each={shown()}>{(asset) => <li class="flex min-w-0 flex-col gap-1 rounded-card border border-outline-gray-2 p-3" data-testid="learned-entry">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <h3 class="m-0 min-w-0 flex-1 break-words text-base-medium text-ink-gray-9">{entryTitle(asset)}</h3>
            <Show when={asset.autoPublished || asset.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label={t("library.learned.selfReviewed")} /></Show>
          </div>
          <p class="m-0 break-words text-interface text-ink-gray-8">{plainSnippet(asset.content)}</p>
          <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-ink-gray-6">
            <span data-testid="learned-from">
              <Show when={asset.missionId} fallback={t("library.learned.addedByHand")}>
                {(missionId) => <>{t("library.learned.from")} <A class="text-ink-blue-link underline focus-visible:focus-ring" href={missionHref(app.workspaceId(), missionId(), "outputs")}>{titles().get(missionId()) ?? t("library.learned.earlierMission")}</A></>}
              </Show>
            </span>
            <span>{t("library.learned.when", { when: formatDateTime(asset.createdAt) })}</span>
            <Show when={asset.helpedCount !== undefined}><span data-testid="learned-helped">{tn("library.learned.helped", asset.helpedCount ?? 0)}</span></Show>
            <Show when={asset.expiresAt}>{(expires) => <span data-testid="learned-expires">{t("library.learned.expires", { when: formatRelative(expires()) })}</span>}</Show>
          </p>
        </li>}</For>
      </ul>
      <Show when={total() > items().length}><p class="m-0 mt-2 text-caption text-ink-gray-6">{t("library.learned.newest", { n: items().length, total: total() })}</p></Show>
      <Pager count={items().length} page={currentPage()} onPage={setPage} label={t("library.learned.pager")} />
    </ScreenRegion>
  </WorkspaceSection>;
}
