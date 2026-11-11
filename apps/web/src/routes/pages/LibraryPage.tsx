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
    refreshMs: 10_000,
  });
  const base = () => `/w/${app.workspaceId()}`;
  const shelves = (): Array<{ id: string; label: string; count: (value: LibrarySummary) => number; description: string; icon: string; href: string; emphasis?: boolean }> => [
    { id: "review", label: "Awaiting your review", count: (value) => value.awaitingReview, description: needsPersonNote(summary.state().data), icon: "lucide-list-checks", href: `${base()}/knowledge/review`, emphasis: true },
    { id: "auto", label: "Published automatically", count: (value) => value.publishedAutomatically, description: "Verified write-ups Brain published itself, marked self-reviewed. Withdraw any of them at any time.", icon: "lucide-sparkles", href: `${base()}/knowledge/review` },
    { id: "knowledge", label: "Published knowledge", count: (value) => value.publishedKnowledge, description: "Approved write-ups. Search and future plans use them, with their source.", icon: "lucide-brain", href: `${base()}/knowledge` },
    { id: "documents", label: "Documents", count: (value) => value.documents, description: "Files you added or saved from a result. Searchable by agents as soon as they are read.", icon: "lucide-file-text", href: `${base()}/knowledge?tab=documents` },
    { id: "plays", label: "Plays", count: (value) => value.plays, description: "Ready-made teams and plans you can start a mission from.", icon: "lucide-book-open-check", href: `${base()}/plays` },
    { id: "tools", label: "Tools", count: (value) => value.tools, description: "The governed tools agents may use in this workspace.", icon: "lucide-wrench", href: `${base()}/knowledge?tab=tools` },
  ];
  return <div class="flex min-w-0 flex-col gap-3">
    <LibraryTabs value="overview" />
    <BrainPage title="Library" description="Everything Brain can reuse: documents, knowledge, Plays and tools. Each finished mission makes the next one easier."
      actions={<Button variant="outline" iconLeft="lucide-file-plus" onClick={() => void navigate(`${base()}/knowledge?tab=documents&add=1`)}>Add a document</Button>}>
      <PageStack>
        <WorkspaceSection title="What is in the Library" description="Counts are exact. Open a shelf to read, search or review it.">
          <ScreenRegion state={summary.state()} onRetry={() => void summary.refresh({ force: true })} emptyTitle="Nothing here yet" emptyDescription="Add a document or finish a mission and the Library starts to fill.">
            <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="library-shelves">
              <For each={shelves()}>{(shelf) => <button type="button" data-testid={`library-shelf-${shelf.id}`} data-emphasis={shelf.emphasis ? "true" : "false"}
                classList={{ "border-outline-blue-2": Boolean(shelf.emphasis && (summary.state().data ? shelf.count(summary.state().data!) : 0) > 0) }}
                class="brain-shelf flex min-w-0 flex-col items-start gap-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4 text-left hover:bg-surface-gray-1 focus-visible:focus-ring"
                aria-label={`${shelf.label}: ${summary.state().data ? shelf.count(summary.state().data!) : "loading"}. ${shelf.description}`} onClick={() => void navigate(shelf.href)}>
                <span class="flex items-center gap-2 text-interface font-medium text-ink-gray-9"><span class={`${shelf.icon} size-4`} aria-hidden="true" />{shelf.label}</span>
                <span class="text-heading tabular-nums" data-testid={`library-count-${shelf.id}`}>{summary.state().data ? shelf.count(summary.state().data!) : "…"}</span>
                <span class="brain-shelf-note text-caption text-ink-gray-7">{shelf.description}</span>
              </button>}</For>
            </div>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title="Hands-off" description="What Brain does for you without a click.">
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
        <p class="text-interface text-ink-gray-7">Reuse is on by default: Brain looks here before it plans, offers similar past work, and says on each result what it reused. Withdraw anything from search at any time.</p>
      </PageStack>
    </BrainPage>
  </div>;
}
