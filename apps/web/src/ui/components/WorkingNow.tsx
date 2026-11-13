import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { Mission } from "@brain/contracts";
import { useApp } from "../app-context";
import { missionHref } from "../mission-links";
import { formatRelative } from "../format";
import { t, tn } from "../../i18n";

/** Missions with at least one task running right now, read from the one shared missions snapshot. */
export function runningMissions(missions: readonly Mission[]): Mission[] {
  return missions.filter((mission) => mission.state !== "closed" && mission.usage.runningMembers > 0);
}

/**
 * The "Working now" strip on Today: what is running right now, one row per mission, each opening that
 * mission's Live view. It reads the same missions snapshot as the Missions list and the header counts, so
 * "running" here, in the Running filter and in the counts cannot disagree.
 */
export function WorkingNow(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const missions = app.useMissions();
  const all = () => missions.state().data ?? [];
  const running = () => runningMissions(all());
  const tasks = () => running().reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  return <Show when={all().length > 0}>
    <section class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 bg-surface-gray-1 p-3 sm:p-4" aria-label={t("working.title")} data-testid="working-now">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 class="m-0 flex items-center gap-2 text-section text-ink-gray-9">
          <span class={`size-2.5 shrink-0 rounded-full ${running().length ? "bg-surface-green-7 brain-live-dot" : "bg-surface-gray-5"}`} aria-hidden="true" />{t("working.title")}
        </h2>
        <Show when={running().length > 0}>
          <span class="text-caption text-ink-gray-7" data-testid="working-now-count">{tn("working.missions", running().length)} · {tn("working.tasks", tasks())}</span>
        </Show>
      </div>
      <Show when={running().length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7" data-testid="working-now-idle">{t("working.none")}</p>}>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={running()}>{(mission) => <li>
            <button type="button" class="brain-queue-row w-full" aria-label={t("working.open", { title: mission.title })} onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))}>
              <span class="lucide-radio size-5 shrink-0 text-ink-green-8" aria-hidden="true" />
              <span class="min-w-0 text-start">
                <span class="block break-words text-base-medium text-ink-gray-9">{mission.title}</span>
                <span class="block text-caption text-ink-gray-7">{tn("working.tasks", mission.usage.runningMembers)} · {t("working.updated", { when: formatRelative(mission.updatedAt) })}</span>
              </span>
              <span class="lucide-arrow-right size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
            </button>
          </li>}</For>
        </ul>
        <div><Button variant="ghost" size="sm" iconRight="lucide-arrow-right" onClick={() => void navigate(`/w/${app.workspaceId()}/missions?show=running`)}>{t("working.seeAll")}</Button></div>
      </Show>
    </section>
  </Show>;
}
