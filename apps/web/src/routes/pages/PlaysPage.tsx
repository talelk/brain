import { For } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { PlayView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";

/** Plays (#43): reusable mission templates of the active release, started by hand, schedule or trigger. */
export default function PlaysPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const plays = createScopedRead<PlayView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: PlayView[] }; asOf: string; sourceWatermark: number }>({ queryType: "plays.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  return <BrainPage title="Plays" description="Mission templates: a team, a plan shape and a brief, started by hand, on a schedule or by a ticket or incident.">
    <PageStack>
      <WorkspaceSection title="Plays in the active release" description="Author plays in the Studio; schedules and subject triggers live in Schedules."
        actions={<Button size="md" variant="outline" iconLeft="lucide-calendar-clock" onClick={() => void navigate(`/w/${app.workspaceId()}/schedules`)}>Schedules</Button>}>
        <ScreenRegion state={plays.state()} onRetry={() => void plays.refresh({ force: true })} emptyTitle="No plays yet" emptyDescription="Draft a play in the Studio and activate the release that contains it.">
          <div class="brain-queue"><For each={plays.state().data ?? []}>{(play) => <QueueRow title={play.title} description={play.description ?? `${play.taskCount} tasks`} icon="lucide-book-open-check"
            meta={<><span>{play.team.length} members</span><span>{play.taskCount} tasks</span><span>autonomy {play.autonomy ?? "standard"}</span></>}
            label={`Start a mission from ${play.title}`} onClick={() => void navigate(`/w/${app.workspaceId()}/missions/new?play=${encodeURIComponent(play.playId)}`)} />}</For></div>
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceSection title="Play views" description="Queues of subjects that plays start missions for.">
        <div class="flex flex-wrap gap-2">
          <Button size="md" variant="outline" iconLeft="lucide-life-buoy" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/support`)}>Support tickets</Button>
          <Button size="md" variant="outline" iconLeft="lucide-siren" onClick={() => void navigate(`/w/${app.workspaceId()}/plays/sre`)}>Incidents</Button>
          <Button size="md" variant="outline" iconLeft="lucide-play" onClick={() => void navigate(`/w/${app.workspaceId()}/workflows`)}>Start a single task</Button>
        </div>
      </WorkspaceSection>
    </PageStack>
  </BrainPage>;
}
