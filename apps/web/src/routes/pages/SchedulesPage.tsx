import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import type { Mission, PlayView, WorkflowCatalogEntry, WorkItem } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { SchedulesPanel, type ScheduleTarget } from "../../ui/components/SchedulesPanel";
import { RepeatSheet } from "../../ui/components/RepeatSheet";
import { t } from "../../i18n";

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
  // `?repeat=<missionId>` opens the preset picker for a finished mission (#56).
  const repeatId = () => text("repeat");
  const [repeatClosed, setRepeatClosed] = createSignal(false);
  const [created, setCreated] = createSignal(0);
  const repeating = createScopedRead<Mission | undefined>({
    scope: app.scope,
    load: async (scope, signal) => {
      const id = repeatId();
      if (!id) return { snapshot: undefined, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: Mission; asOf: string; sourceWatermark: number }>({ queryType: "missions.get", workspaceId: scope.workspaceId, resourceId: id }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  return <BrainPage title={t("sched.schedules.26d9")} description={t("sched.every-recurring-one-off-and-manu.4769")}>
    <PageStack>
      <Show when={repeating.state().data}>{(mission) => <RepeatSheet mission={mission()} open={!repeatClosed()} onClose={() => setRepeatClosed(true)} onCreated={() => setCreated((count) => count + 1)} />}</Show>
      <SchedulesPanel refreshKey={created()} targets={targets.state().data ?? []} focus={text("target")} create={text("create")} />
    </PageStack>
  </BrainPage>;
}
