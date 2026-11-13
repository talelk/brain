import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { librarySummary, type LibrarySummary } from "../../data/library";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { t } from "../../i18n";
import { LibraryTabs } from "../../ui/components/LibraryTabs";
import { AddStarterPlays, AutoPublishSetting } from "../../ui/components/LibraryControls";

/** What the first number means: only the items that truly need a person, named by kind. */
function needsPersonNote(data: LibrarySummary | undefined): string {
  if (!data) return "";
  const { writeups, tools, plays } = data.needsPerson;
  const parts = [writeups > 0 ? `${writeups} write-up${writeups === 1 ? "" : "s"}` : "", tools > 0 ? `${tools} tool proposal${tools === 1 ? "" : "s"}` : "", plays > 0 ? `${plays} Play proposal${plays === 1 ? "" : "s"}` : ""].filter(Boolean);
  const base = data.autoPublishKnowledge === false ? "Write-ups wait for your OK because automatic publishing is off." : "Tool and Play proposals, and any write-up that needs a second person or holds a secret. Verified write-ups publish themselves.";
  return parts.length > 0 ? `${parts.join(", ")}. ${base}` : base;
}

/**
 * `/w/:id/library` (ADR 0014): the first-class place for everything Brain can reuse. One screen counts what is waiting for
 * review and what is already published, then sends you to the shelf: Plays, Knowledge, Documents, Tools and the Review inbox.
 */
export default function LibraryPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const summary = createScopedRead<LibrarySummary>({
    scope: app.scope,
    load: async (scope, signal) => librarySummary(scope.workspaceId, signal),
  });
  const base = () => `/w/${app.workspaceId()}`;
  const shelves = (): Array<{ id: string; label: string; count: (value: LibrarySummary) => number; description: string; icon: string; href: string; emphasis?: boolean }> => [
    { id: "review", label: t("library.shelf.review"), count: (value) => value.awaitingReview, description: needsPersonNote(summary.state().data), icon: "lucide-list-checks", href: `${base()}/knowledge/review`, emphasis: true },
    { id: "auto", label: t("library.shelf.auto"), count: (value) => value.publishedAutomatically, description: t("library.shelf.auto.note"), icon: "lucide-sparkles", href: `${base()}/knowledge/review` },
    { id: "knowledge", label: t("library.shelf.knowledge"), count: (value) => value.publishedKnowledge, description: t("library.shelf.knowledge.note"), icon: "lucide-brain", href: `${base()}/knowledge` },
    { id: "documents", label: t("library.shelf.documents"), count: (value) => value.documents, description: t("library.shelf.documents.note"), icon: "lucide-file-text", href: `${base()}/knowledge?tab=documents` },
    { id: "plays", label: t("library.shelf.plays"), count: (value) => value.plays, description: t("library.shelf.plays.note"), icon: "lucide-book-open-check", href: `${base()}/plays` },
    { id: "tools", label: t("library.shelf.tools"), count: (value) => value.tools, description: t("library.shelf.tools.note"), icon: "lucide-wrench", href: `${base()}/knowledge?tab=tools` },
  ];
  return <div class="flex min-w-0 flex-col gap-3">
    <LibraryTabs value="overview" />
    <BrainPage title={t("library.title")} description={t("library.description")}
      actions={<Button variant="outline" iconLeft="lucide-file-plus" onClick={() => void navigate(`${base()}/knowledge?tab=documents&add=1`)}>{t("library.addDocument")}</Button>}>
      <PageStack>
        <WorkspaceSection title={t("library.shelves.title")} description={t("library.shelves.description")}>
          <ScreenRegion state={summary.state()} onRetry={() => void summary.refresh({ force: true })} emptyTitle={t("library.empty.title")} emptyDescription={t("library.empty.description")}>
            <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="library-shelves">
              <For each={shelves()}>{(shelf) => <button type="button" data-testid={`library-shelf-${shelf.id}`} data-emphasis={shelf.emphasis ? "true" : "false"}
                classList={{ "border-outline-blue-2": Boolean(shelf.emphasis && (summary.state().data ? shelf.count(summary.state().data!) : 0) > 0) }}
                class="brain-shelf flex min-w-0 flex-col items-start gap-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4 text-start hover:bg-surface-gray-1 focus-visible:focus-ring"
                aria-label={`${shelf.label}: ${summary.state().data ? shelf.count(summary.state().data!) : "loading"}. ${shelf.description}`} onClick={() => void navigate(shelf.href)}>
                <span class="flex items-center gap-2 text-interface font-medium text-ink-gray-9"><span class={`${shelf.icon} size-4`} aria-hidden="true" />{shelf.label}</span>
                <span class="text-heading tabular-nums" data-testid={`library-count-${shelf.id}`}>{summary.state().data ? shelf.count(summary.state().data!) : "…"}</span>
                <span class="brain-shelf-note text-caption text-ink-gray-7">{shelf.description}</span>
              </button>}</For>
            </div>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title={t("library.handsOff.title")} description={t("library.handsOff.description")}>
          <div class="flex min-w-0 flex-col gap-3">
            <AutoPublishSetting summary={summary.state().data} onChanged={() => void summary.refresh({ force: true })} />
            <Show when={(summary.state().data?.starterPlays.installable ?? 0) > 0}>
              <div class="flex min-w-0 flex-wrap items-center gap-3">
                <AddStarterPlays summary={summary.state().data} onAdded={() => void summary.refresh({ force: true })} />
                <span class="text-caption text-ink-gray-7">Research and write, compare options, checklist, weekly status, customer reply draft, incident triage. They become ordinary Plays you can edit.</span>
              </div>
            </Show>
          </div>
        </WorkspaceSection>
        <p class="text-interface text-ink-gray-7">{t("library.reuse.note")}</p>
      </PageStack>
    </BrainPage>
  </div>;
}
