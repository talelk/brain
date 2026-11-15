import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Card } from "@talelk/newui-molecules";
import { useApp } from "../../ui/app-context";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { attentionHref, resultName } from "../../ui/components/AttentionDrawer";
import { NeedsYouQueue } from "../../ui/components/NeedsYouQueue";
import { WorkingNow, runningMissions } from "../../ui/components/WorkingNow";
import { FleetOverviewPanel } from "../../ui/components/FleetOverviewPanel";
import { ATTENTION_CHANGED, blockingCount, createAttentionRead } from "../../ui/attention";
import { missionHref, sameTitleHints } from "../../ui/mission-links";
import { formatDateTime, formatRelative } from "../../ui/format";
import { missionStateLabel, missionOutcomeLabel } from "../../ui/mission-words";
import { PlainSummary } from "../../ui/viz/PlainSummary";
import { createStartController, StartFields } from "../../ui/start/StartBox";
import { blockedBy, TodaySetup } from "../../ui/components/TodaySetup";
import { createReadiness } from "../../ui/components/OperationalChecklist";
import { InstallPrompt } from "../../ui/install";
import { KnowledgeLine } from "../../ui/components/LibraryControls";
import { t, tn } from "../../i18n";

const SEEN_KEY = "brain-results-seen";
const readSeen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]; } catch { return []; } };
const writeSeen = (ids: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200))); } catch { /* per-viewer convenience only */ } };
const NEEDS_YOU_VISIBLE = 3;

/**
 * Today (#47): where Brain lands. The first element is one box; anything that needs a person comes next
 * (one decision card each), then what is working now, then the latest missions. The Governor applies the
 * default budget, so a sentence is all a first-time user has to give.
 */
export default function TodayPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const start = createStartController();
  const attention = createAttentionRead();
  const readiness = createReadiness();
  /** Missing model, release or runners block the box; while readiness is unknown nothing is blocked. */
  const blocked = () => blockedBy(readiness.state().data?.checks ?? []).length > 0;
  /** Every slot of a capable runner is in use: the mission still starts, it queues behind the work in progress. */
  const busyCount = () => (readiness.state().data?.checks ?? []).reduce((most, check) => Math.max(most, check.busy?.slotsInUse ?? 0), 0);
  /** After an inline decision: every attention read (this one and the bell) and the missions list (their versions) re-read. */
  const changed = () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); void start.missions.refresh({ force: true }); };
  const items = () => attention.state().data ?? [];
  const waitingItems = () => items().filter((item) => item.kind !== "result-ready");
  const readyItems = () => items().filter((item) => item.kind === "result-ready");
  const hints = () => sameTitleHints(start.missions.state().data ?? [], formatDateTime);
  const recent = () => [...(start.missions.state().data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const running = () => runningMissions(start.missions.state().data ?? []).reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  const [showAllNeeds, setShowAllNeeds] = createSignal(false);
  const [seen, setSeen] = createSignal(readSeen());
  const newestResults = () => readyItems().filter((item) => !seen().includes(item.id)).sort((a, b) => b.waitingSince.localeCompare(a.waitingSince));
  const markAllSeen = () => { const next = [...new Set([...seen(), ...readyItems().map((item) => item.id)])]; setSeen(next); writeSeen(next); };
  const visibleNeeds = () => showAllNeeds() ? waitingItems() : waitingItems().slice(0, NEEDS_YOU_VISIBLE);
  const summary = () => tn("today.summary", blockingCount(items()), { m: running() });
  const setup = <TodaySetup readiness={readiness} />;
  return <BrainPage title={t("nav.today")} description={t("today.description")}>
    <PageStack>
      {/* The box always leads, even while setup is unfinished (it is then disabled and the checklist sits right under it). */}
      <Card padding="md" class="flex min-w-0 flex-col gap-3" aria-label={t("today.startRegion")} data-blocked={blocked() ? "true" : "false"}>
        <StartFields start={start} compact sample disabled={blocked()} onSubmit={() => void start.start()}
          dockAction={<Button class="brain-dock-start" variant="solid" theme="blue" iconLeft="lucide-flag" loading={start.busy()} disabled={start.busy() || !start.canStart() || blocked()} onClick={() => void start.start()}>{t("start.button")}</Button>} />
        <Show when={!blocked() && busyCount() > 0}><p class="m-0 flex items-center gap-2 text-caption text-ink-gray-7" data-testid="today-busy-note"><span class="lucide-loader size-4 shrink-0" aria-hidden="true" />{tn("start.busyNote", busyCount())}</p></Show>
        <Show when={start.error()}><p role="alert" class="text-interface text-ink-red-7">{start.error()}</p></Show>
        <div class="brain-start-footer flex flex-wrap items-center justify-between gap-3">
          <p class="m-0 text-caption text-ink-gray-7">{blocked() ? t("start.footer.blocked") : t("start.footer.ready")}</p>
          <Button class="brain-footer-start" variant="solid" theme="blue" iconLeft="lucide-flag" loading={start.busy()} disabled={start.busy() || !start.canStart() || blocked()} onClick={() => void start.start()}>{t("start.button")}</Button>
        </div>
      </Card>
      <Show when={waitingItems().length}>
        <WorkspaceSection title={t("decision.queue")} description={`${summary()} ${t("today.needsYou.hint")}`}>
          <NeedsYouQueue items={visibleNeeds()} missions={start.missions.state().data ?? []} onChanged={changed} />
          <Show when={waitingItems().length > NEEDS_YOU_VISIBLE}>
            <div class="mt-2"><Button variant="ghost" size="sm" iconRight={showAllNeeds() ? "lucide-chevron-up" : "lucide-chevron-down"} aria-expanded={showAllNeeds()} onClick={() => setShowAllNeeds(!showAllNeeds())}>{showAllNeeds() ? t("today.showFewer") : t("today.moreCount", { n: waitingItems().length - NEEDS_YOU_VISIBLE })}</Button></div>
          </Show>
        </WorkspaceSection>
      </Show>
      <WorkingNow />
      <FleetOverviewPanel />
      {setup}
      <Show when={!waitingItems().length && (items().length || recent().length)}>
        <PlainSummary icon="lucide-circle-check">{summary()}</PlainSummary>
      </Show>
      <Show when={newestResults().length}>
        <details class="brain-results-ready rounded-card border border-outline-gray-2 bg-surface-gray-1" data-testid="results-ready">
          <summary class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 sm:px-4">
            <span class="lucide-circle-check-big size-5 shrink-0 text-ink-green-8" aria-hidden="true" />
            <span class="min-w-0 flex-1 text-base-medium text-ink-gray-9">{tn("today.results.ready", newestResults().length)}<span class="ms-2 text-interface font-normal text-ink-gray-7">{t("today.results.note")}</span></span>
          </summary>
          <ul class="m-0 flex list-none flex-col border-t border-outline-gray-1 p-0">
            <For each={newestResults().slice(0, 8)}>{(item) => <li><button type="button" class="brain-queue-row w-full" aria-label={`${resultName(item.title)}. ${t("decision.seeResult")}`} onClick={() => void navigate(attentionHref(item))}>
              <span class="min-w-0 text-start"><span class="block break-words text-interface text-ink-gray-9">{resultName(item.title)}</span><span class="block text-caption text-ink-gray-6">{t("decision.finished", { when: formatRelative(item.waitingSince) })}</span></span>
              <span class="lucide-arrow-right size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
            </button></li>}</For>
          </ul>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 p-2 sm:px-3">
            <span class="text-caption text-ink-gray-6">{newestResults().length > 8 ? t("today.results.newest", { n: newestResults().length }) : ""}</span>
            <Button variant="ghost" size="sm" onClick={markAllSeen}>{t("today.results.markSeen")}</Button>
          </div>
        </details>
      </Show>
      <Show when={(start.missions.state().data ?? []).some((mission) => mission.outcome === "achieved")}><InstallPrompt /></Show>
      <KnowledgeLine summary={start.library.state().data} onChanged={() => void start.library.refresh({ force: true })} />
      <Show when={recent().length}>
        <WorkspaceSection title={t("today.latest.title")} description={t("today.latest.description")}
          actions={<Button variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(`/w/${app.workspaceId()}/missions`)}>{t("today.latest.all")}</Button>}>
          <div class="brain-queue"><For each={recent()}>{(mission) =>
            <QueueRow title={hints().has(mission.missionId) ? `${mission.title} · ${t("missions.startedAt", { when: hints().get(mission.missionId)! })}` : mission.title} description={mission.intent.trim().toLowerCase() === mission.title.trim().toLowerCase() ? "" : mission.intent.length > 140 ? `${mission.intent.slice(0, 137).trimEnd()}…` : mission.intent} icon="lucide-flag" tone={mission.state === "active" ? "blue" : mission.state === "paused" ? "amber" : "gray"}
              label={t("missions.open", { title: mission.title })} meta={<span>{missionStateLabel(mission.state)}{mission.outcome ? ` · ${missionOutcomeLabel(mission.outcome)}` : ""} · {t("missions.updated", { when: formatRelative(mission.updatedAt) })}</span>}
              onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId))} />}</For></div>
        </WorkspaceSection>
      </Show>
      <div class="brain-dock-spacer" aria-hidden="true" />
    </PageStack>
  </BrainPage>;
}
