import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import type { PlayView, WorkflowCatalogEntry, WorkItem } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { SchedulesPanel, type ScheduleTarget } from "../../ui/components/SchedulesPanel";

type Envelope<T> = { snapshot: { items: T[] }; asOf: string; sourceWatermark: number };

/**
 * Schedules: the single home of every recurring, one-off and manual start in
 * the workspace. Plays, tasks and missions link here (`?target=` narrows the
 * list, `?create=` opens the editor for one target).
 */
export default function SchedulesPage(): JSX.Element {
  const app = useApp();
  const [params] = useSearchParams();
  const text = (key: string) => typeof params[key] === "string" ? params[key] : undefined;
  const targets = createScopedRead<ScheduleTarget[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [plays, workflows, items] = await Promise.all([
        query<Envelope<PlayView>>({ queryType: "plays.list", workspaceId: scope.workspaceId }, signal),
        query<Envelope<WorkflowCatalogEntry>>({ queryType: "workflows.list", workspaceId: scope.workspaceId }, signal),
        query<Envelope<WorkItem>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal),
      ]);
      const playTargets = plays.snapshot.items.map((play): ScheduleTarget => ({ kind: "play", id: play.playId, label: play.title }));
      const taskTargets = workflows.snapshot.items.map((workflow): ScheduleTarget => ({ kind: "workflow", id: workflow.release.id, label: workflow.release.id }));
      const itemTargets = items.snapshot.items.map((item): ScheduleTarget => ({ kind: "workItem", id: item.workItemId, label: item.title }));
      return { snapshot: [...playTargets, ...taskTargets, ...itemTargets], asOf: plays.asOf, sourceWatermark: plays.sourceWatermark };
    },
  });
  return <BrainPage title="Schedules" description="Every recurring, one-off and manual start in this workspace: what it starts, when it fires next, which host runs it and what happened.">
    <PageStack>
      <SchedulesPanel targets={targets.state().data ?? []} focus={text("target")} create={text("create")} />
    </PageStack>
  </BrainPage>;
}
