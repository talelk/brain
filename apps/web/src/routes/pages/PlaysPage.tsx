import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { PlayView, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";import { TaskEntry } from "../../ui/components/TaskEntry";
import type { TaskHandoff } from "../../ui/components/TaskReview";
import { TaskCatalog } from "../catalog";
import { EmptyState } from "@talelk/newui-molecules";
import { LibraryTabs } from "../../ui/components/LibraryTabs";

/**
 * Plays (#25/#43): the catalog of mission templates and single tasks of the
 * active release, plus the Play views over tickets and incidents. Describing
 * the work or starting from an item reviews the proposal in place; a picked
 * Play or task opens its own page (`/plays/:id`) to review and start.
 */
export default function PlaysPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = () => (typeof params.q === "string" ? params.q : "");
  const plays = createScopedRead<PlayView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: PlayView[] }; asOf: string; sourceWatermark: number }>({ queryType: "plays.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const workflows = createScopedRead<WorkflowCatalogEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: WorkflowCatalogEntry[] }; asOf: string; sourceWatermark: number }>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const shownPlays = () => (plays.state().data ?? []).filter((play) => `${play.playId} ${play.title} ${play.description ?? ""}`.toLowerCase().includes(search().toLowerCase()));
  const canAuthor = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  /** Dispatch handoff: the live console when the run already binds a session, else the run inspector. */
  const handoff = (target: TaskHandoff) => {
    if (target.sessionId) void navigate(`/w/${app.workspaceId()}/live?session=${encodeURIComponent(target.sessionId)}`);
    else void navigate(`/runs/${target.runId}`);
  };
  const describe = () => void setParams({ mode: "ask", goal: search() || undefined, q: undefined });
  const catalog = <PageStack>
    <div class="flex flex-col gap-2">
      <TextInput type="search" label="What do you want to get done?" value={search()} placeholder="Search plays and tasks, or describe the goal in a sentence…" onInput={(event) => setParams({ q: event.currentTarget.value || undefined })} />
      <Show when={search().trim().length > 0}><div class="flex flex-wrap items-center gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3">
        <span class="min-w-0 flex-1 text-interface text-ink-gray-8">Nothing right? Brain can propose a task from your own words, for you to review before anything starts.</span>
        <Button variant="solid" theme="blue" iconLeft="lucide-sparkles" onClick={describe}>Describe it to Brain</Button>
      </div></Show>
    </div>
    <Show when={(plays.state().data ?? []).length > 0 || !["ready", "empty-authorized", "loading"].includes(plays.state().status)}>
      <WorkspaceSection title="Plays" description="Mission templates: a team, a plan shape and a brief.">
        <ScreenRegion state={plays.state()} onRetry={() => void plays.refresh({ force: true })} emptyTitle="No plays yet" emptyDescription="Draft a play in the Studio and activate the release that contains it.">
          <Show when={shownPlays().length} fallback={<EmptyState size="sm" icon="lucide-search" title="No matching plays" description="Clear the search to see every play in the active release." />}>
            <div class="brain-queue"><For each={shownPlays()}>{(play) => <QueueRow title={play.title} description={play.description ?? `${play.taskCount} tasks`} icon="lucide-book-open-check"
              meta={<><span>{play.team.length} members</span><span>{play.taskCount} tasks</span></>}
              label={`Open play ${play.title}`} onClick={() => void navigate(`/plays/${encodeURIComponent(play.playId)}`)} />}</For></div>
          </Show>
        </ScreenRegion>
      </WorkspaceSection>
    </Show>
    <TaskCatalog search={search()} diagnostics={params.diagnostics === "true"} />
    <p class="flex flex-wrap items-center gap-2 text-interface text-ink-gray-7">Starting from a customer request or an incident?
      <Button variant="ghost" iconLeft="lucide-life-buoy" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/support`)}>Support tickets</Button>
      <Button variant="ghost" iconLeft="lucide-siren" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/sre`)}>Incidents</Button></p>
  </PageStack>;
  return <div class="flex min-w-0 flex-col gap-3"><LibraryTabs value="plays" /><BrainPage title="Plays" description="Search for a play or task, or describe the goal and review what Brain proposes."
    actions={<Show when={canAuthor()}><div class="flex flex-wrap gap-2">
      <Button variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Play")}>Play drafts</Button>
      <Button variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Workflow")}>Task drafts</Button>
    </div></Show>}>
    <TaskEntry workflows={workflows.state().data ?? []} onStarted={handoff} catalog={catalog} />
  </BrainPage></div>;
}
