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
    isEmpty: (items) => items.length === 0,
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
  const catalog = <PageStack>
    <TextInput type="search" label="Find a play or task" value={search()} placeholder="Search purpose, play or task name…" onInput={(event) => setParams({ q: event.currentTarget.value || undefined })} />
    <WorkspaceSection title="Plays in the active release" description="Mission templates: a team, a plan shape and a brief, started by hand, on a schedule or by a ticket or incident.">
      <ScreenRegion state={plays.state()} onRetry={() => void plays.refresh({ force: true })} emptyTitle="No plays yet" emptyDescription="Draft a play in the Studio and activate the release that contains it.">
        <Show when={shownPlays().length} fallback={<EmptyState size="sm" icon="lucide-search" title="No matching plays" description="Clear the search to see every play in the active release." />}>
          <div class="brain-queue"><For each={shownPlays()}>{(play) => <QueueRow title={play.title} description={play.description ?? `${play.taskCount} tasks`} icon="lucide-book-open-check"
            meta={<><span>{play.team.length} members</span><span>{play.taskCount} tasks</span><span>autonomy {play.autonomy ?? "standard"}</span></>}
            label={`Open play ${play.title}`} onClick={() => void navigate(`/plays/${encodeURIComponent(play.playId)}`)} />}</For></div>
        </Show>
      </ScreenRegion>
    </WorkspaceSection>
    <TaskCatalog search={search()} diagnostics={params.diagnostics === "true"} />
    <WorkspaceSection title="Play views" description="Queues of the subjects plays start missions for.">
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" iconLeft="lucide-life-buoy" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/support`)}>Support tickets</Button>
        <Button variant="outline" iconLeft="lucide-siren" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/sre`)}>Incidents</Button>
      </div>
    </WorkspaceSection>
  </PageStack>;
  return <BrainPage title="Plays" description="Start a mission from a play, run a single task, or describe the work and review what Brain proposes."
    actions={<Show when={canAuthor()}><div class="flex flex-wrap gap-2">
      <Button variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Play")}>Play drafts</Button>
      <Button variant="outline" iconLeft="lucide-file-pen" onClick={() => void navigate("/studio/Workflow")}>Task drafts</Button>
    </div></Show>}>
    <TaskEntry workflows={workflows.state().data ?? []} onStarted={handoff} catalog={catalog} />
  </BrainPage>;
}
