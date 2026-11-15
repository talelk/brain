import { For, Show, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { FleetOverview } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { fleetOverview } from "../../data/fleet";
import { ATTENTION_CHANGED } from "../attention";
import { missionHref } from "../mission-links";
import { formatUsd } from "../format";
import { t, tn } from "../../i18n";

const VISIBLE_ROWS = 3;

/** One condition of the open missions: a dot, the count and its name, so colour is never the only cue. */
function Condition(props: { tone: string; count: number; label: string; testid: string }): JSX.Element {
  return <li class="flex items-center gap-2" data-testid={props.testid}>
    <span class={`size-2.5 shrink-0 rounded-full ${props.tone}`} aria-hidden="true" />
    <span class="text-base-medium tabular-nums text-ink-gray-9">{props.count}</span>
    <span class="text-interface text-ink-gray-7">{props.label}</span>
  </li>;
}

function Tile(props: { title: string; testid: string; children: JSX.Element }): JSX.Element {
  return <div class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-3" data-testid={props.testid}>
    <h3 class="m-0 text-caption font-medium text-ink-gray-7">{props.title}</h3>
    {props.children}
  </div>;
}

/**
 * Fleet overview on Today (spec #90, stories 43 and 44): what every workspace member may see of everything running. It reads the one
 * `fleet.overview` query through the live store, so its counts move with the strip and queue beside it. Runner internals appear only when
 * the Governor sent them, which it does for a holder of runner administration.
 */
export function FleetOverviewPanel(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const fleet = createScopedRead<FleetOverview>({
    scope: app.scope,
    load: (scope, signal) => fleetOverview(scope.workspaceId, signal),
  });
  // A decision taken on Today (an approval, a plan) moves a mission's condition: re-read now, not at the next live frame.
  const reread = () => void fleet.refresh({ force: true });
  window.addEventListener(ATTENTION_CHANGED, reread);
  onCleanup(() => window.removeEventListener(ATTENTION_CHANGED, reread));
  const data = () => fleet.state().data;
  const failed = () => !data() && ["retry", "offline", "no-access"].includes(fleet.state().status);
  const worth = (view: FleetOverview) => view.missions.open > 0 || view.runners.registered > 0 || view.activeMembers.count > 0 || view.spend.todayMicroUsd > 0;
  const needing = (view: FleetOverview) => view.missions.items.filter((item) => item.condition === "needs-attention").slice(0, VISIBLE_ROWS);
  return <>
    <Show when={failed()}><p class="m-0 text-caption text-ink-gray-7" data-testid="fleet-unavailable">{t("fleet.unavailable")}</p></Show>
    <Show when={data()}>{(view) => <Show when={worth(view())}>
      <section class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-2 bg-surface-gray-1 p-3 sm:p-4" aria-label={t("fleet.title")} data-testid="fleet-overview">
        <div class="flex min-w-0 flex-col gap-1">
          <h2 class="m-0 text-section text-ink-gray-9">{t("fleet.title")}</h2>
          <p class="m-0 text-caption text-ink-gray-7">{t("fleet.description")}</p>
        </div>
        <div class="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Tile title={t("fleet.missions.title")} testid="fleet-missions">
            <Show when={view().missions.open > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("fleet.missions.none")}</p>}>
              <p class="m-0 text-interface text-ink-gray-7">{tn("fleet.missions.open", view().missions.open)}</p>
              <ul class="m-0 flex list-none flex-col gap-1 p-0">
                <Condition tone="bg-surface-amber-7" count={view().missions.needsAttention} label={t("fleet.condition.needs")} testid="fleet-needs-attention" />
                <Condition tone="bg-surface-green-7" count={view().missions.working} label={t("fleet.condition.working")} testid="fleet-working" />
                <Condition tone="bg-surface-gray-5" count={view().missions.waiting} label={t("fleet.condition.waiting")} testid="fleet-waiting" />
              </ul>
              <For each={needing(view())}>{(item) =>
                <button type="button" class="brain-queue-row w-full" onClick={() => void navigate(missionHref(app.workspaceId(), item.missionId))} aria-label={t("missions.open", { title: item.title })}>
                  <span class="min-w-0 break-words text-start text-interface text-ink-gray-9">{item.title}</span>
                  <span class="lucide-arrow-right size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
                </button>}</For>
            </Show>
          </Tile>
          <Tile title={t("fleet.members.title")} testid="fleet-members">
            <Show when={view().activeMembers.count > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("fleet.members.none")}</p>}>
              <p class="m-0 text-interface text-ink-gray-7" data-testid="fleet-members-count">{tn("fleet.members.count", view().activeMembers.count)}</p>
              <ul class="m-0 flex list-none flex-col gap-1 p-0">
                <For each={view().activeMembers.items.slice(0, VISIBLE_ROWS)}>{(member) =>
                  <li class="break-words text-interface text-ink-gray-9">{t("fleet.members.row", { role: member.role, mission: member.missionTitle })}</li>}</For>
              </ul>
            </Show>
          </Tile>
          <Tile title={t("fleet.runners.title")} testid="fleet-runners">
            <Show when={view().runners.registered > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("fleet.runners.none")}</p>}>
              <p class="m-0 text-base-medium tabular-nums text-ink-gray-9" data-testid="fleet-slots">{t("fleet.runners.slots", { used: view().runners.slotsUsed, total: view().runners.slotsTotal })}</p>
              <p class="m-0 text-interface text-ink-gray-7" data-testid="fleet-runners-online">{tn("fleet.runners.online", view().runners.registered, { online: view().runners.online })}</p>
              <p class="m-0 text-caption text-ink-gray-6">{t("fleet.runners.shared")}</p>
            </Show>
            <Show when={view().runners.detail}>
              <div><Button variant="ghost" size="sm" iconRight="lucide-arrow-right" onClick={() => void navigate("/runners")}>{t("fleet.runners.details")}</Button></div>
            </Show>
          </Tile>
          <Tile title={t("fleet.spend.title")} testid="fleet-spend">
            <p class="m-0 text-heading tabular-nums text-ink-gray-9" data-testid="fleet-spend-today">{formatUsd(view().spend.todayMicroUsd)}</p>
            <p class="m-0 text-caption text-ink-gray-7">{t("fleet.spend.note")}</p>
            <Show when={view().spend.dailyCapMicroUsd !== undefined}><p class="m-0 text-caption text-ink-gray-6">{t("fleet.spend.cap", { cap: formatUsd(view().spend.dailyCapMicroUsd) })}</p></Show>
          </Tile>
        </div>
        <Show when={view().attentionOutsideMissions > 0}><p class="m-0 text-caption text-ink-gray-7" data-testid="fleet-outside">{tn("fleet.outside", view().attentionOutsideMissions)}</p></Show>
      </section>
    </Show>}</Show>
  </>;
}
