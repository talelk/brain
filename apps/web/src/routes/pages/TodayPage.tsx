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
import { ATTENTION_CHANGED, blockingCount, createAttentionRead } from "../../ui/attention";
import { missionHref } from "../../ui/mission-links";
import { formatRelative } from "../../ui/format";
import { PlainSummary } from "../../ui/viz/PlainSummary";
import { createStartController, StartFields } from "../../ui/start/StartBox";
import { blockedBy, TodaySetup } from "../../ui/components/TodaySetup";
import { createReadiness } from "../../ui/components/OperationalChecklist";
import { KnowledgeLine } from "../../ui/components/LibraryControls";

const SEEN_KEY = "brain-results-seen";
const readSeen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]; } catch { return []; } };
const writeSeen = (ids: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200))); } catch { /* per-viewer convenience only */ } };
const NEEDS_YOU_VISIBLE = 3;

/**
 * Today (#47): where Brain lands. The first element is one box; anything that
 * needs a person comes next, then the latest missions. The Governor applies the
 * default budget, so a sentence is all a first-time user has to give.
 */
export default function TodayPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const start = createStartController();
  const attention = createAttentionRead();
  const readiness = createReadiness(6000);
  /** Missing model, release or runners block the box; while readiness is unknown nothing is blocked. */
  const blocked = () => blockedBy(readiness.state().data?.checks ?? []).length > 0;
  /** Every slot of a capable runner is in use: the mission still starts, it queues behind the work in progress. */
  const busyCount = () => (readiness.state().data?.checks ?? []).reduce((most, check) => Math.max(most, check.busy?.slotsInUse ?? 0), 0);
  /** After an inline decision: every attention read (this one and the bell) and the missions list (their versions) re-read. */
  const changed = () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); void start.missions.refresh({ force: true }); };
  const items = () => attention.state().data ?? [];
  const waitingItems = () => items().filter((item) => item.kind !== "result-ready");
  const readyItems = () => items().filter((item) => item.kind === "result-ready");
  const recent = () => [...(start.missions.state().data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const running = () => (start.missions.state().data ?? []).reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  const [showAllNeeds, setShowAllNeeds] = createSignal(false);
  const [seen, setSeen] = createSignal(readSeen());
  const newestResults = () => readyItems().filter((item) => !seen().includes(item.id)).sort((a, b) => b.waitingSince.localeCompare(a.waitingSince));
  const markAllSeen = () => { const next = [...new Set([...seen(), ...readyItems().map((item) => item.id)])]; setSeen(next); writeSeen(next); };
  const visibleNeeds = () => showAllNeeds() ? waitingItems() : waitingItems().slice(0, NEEDS_YOU_VISIBLE);
  const summary = () => {
    const waiting = blockingCount(items());
    return `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you, ${running()} ${running() === 1 ? "agent" : "agents"} working.`;
  };
  const setup = <TodaySetup readiness={readiness} />;
  return <BrainPage title="Today" description="Say what you want done. Brain drafts a plan and waits for your OK before anything runs.">
    <PageStack>
      {/* The box always leads, even while setup is unfinished (it is then disabled and the checklist sits right under it). */}
      <Card padding="md" class="flex min-w-0 flex-col gap-3" aria-label="Start a mission" data-blocked={blocked() ? "true" : "false"}>
        <StartFields start={start} compact sample disabled={blocked()} onSubmit={() => void start.start()} />
        <Show when={!blocked() && busyCount() > 0}><p class="m-0 flex items-center gap-2 text-caption text-ink-gray-7" data-testid="today-busy-note"><span class="lucide-loader size-4 shrink-0" aria-hidden="true" />Brain is working on {busyCount()} {busyCount() === 1 ? "thing" : "things"}; yours queues and starts next.</p></Show>
        <Show when={start.error()}><p role="alert" class="text-interface text-ink-red-7">{start.error()}</p></Show>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="m-0 text-caption text-ink-gray-7">{blocked() ? "Blocked until the setup below is done." : "Nothing runs until you confirm the plan."}</p>
          <Button variant="solid" theme="blue" iconLeft="lucide-flag" loading={start.busy()} disabled={start.busy() || !start.canStart() || blocked()} onClick={() => void start.start()}>Start</Button>
        </div>
      </Card>
      <Show when={waitingItems().length}>
        <WorkspaceSection title="Needs you" description={`${summary()} Decide each one right here.`}>
          <NeedsYouQueue items={visibleNeeds()} missions={start.missions.state().data ?? []} onChanged={changed} />
          <Show when={waitingItems().length > NEEDS_YOU_VISIBLE}>
            <div class="mt-2"><Button variant="ghost" size="sm" iconRight={showAllNeeds() ? "lucide-chevron-up" : "lucide-chevron-down"} aria-expanded={showAllNeeds()} onClick={() => setShowAllNeeds(!showAllNeeds())}>{showAllNeeds() ? "Show fewer" : `${waitingItems().length - NEEDS_YOU_VISIBLE} more`}</Button></div>
          </Show>
        </WorkspaceSection>
      </Show>
      {setup}
      <Show when={!waitingItems().length && (items().length || recent().length)}>
        <PlainSummary icon="lucide-circle-check">{summary()}</PlainSummary>
      </Show>
      <Show when={newestResults().length}>
        <details class="brain-results-ready rounded-card border border-outline-gray-2 bg-surface-gray-1" data-testid="results-ready">
          <summary class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 sm:px-4">
            <span class="lucide-circle-check-big size-5 shrink-0 text-ink-green-8" aria-hidden="true" />
            <span class="min-w-0 flex-1 text-base-medium text-ink-gray-9">{newestResults().length} {newestResults().length === 1 ? "result" : "results"} ready<span class="ms-2 text-interface font-normal text-ink-gray-7">Finished and verified. Nothing is waiting on you.</span></span>
          </summary>
          <ul class="m-0 flex list-none flex-col border-t border-outline-gray-1 p-0">
            <For each={newestResults().slice(0, 8)}>{(item) => <li><button type="button" class="brain-queue-row w-full" aria-label={`${resultName(item.title)}. See result`} onClick={() => void navigate(attentionHref(item))}>
              <span class="min-w-0 text-start"><span class="block break-words text-interface text-ink-gray-9">{resultName(item.title)}</span><span class="block text-caption text-ink-gray-6">Finished {formatRelative(item.waitingSince)}</span></span>
              <span class="lucide-arrow-right size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
            </button></li>}</For>
          </ul>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 p-2 sm:px-3">
            <span class="text-caption text-ink-gray-6">{newestResults().length > 8 ? `Newest 8 of ${newestResults().length}.` : ""}</span>
            <Button variant="ghost" size="sm" onClick={markAllSeen}>Mark all seen</Button>
          </div>
        </details>
      </Show>
      <KnowledgeLine summary={start.library.state().data} onChanged={() => void start.library.refresh({ force: true })} />
      <Show when={recent().length}>
        <WorkspaceSection title="Latest missions" description="The five most recently updated."
          actions={<Button variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(`/w/${app.workspaceId()}/missions`)}>All missions</Button>}>
          <div class="brain-queue"><For each={recent()}>{(mission) =>
            <QueueRow title={mission.title} description={mission.intent} icon="lucide-flag" tone={mission.state === "active" ? "blue" : mission.state === "paused" ? "amber" : "gray"}
              label={`Open mission ${mission.title}`} meta={<span>{mission.state}{mission.outcome ? ` · ${mission.outcome}` : ""} · updated {formatRelative(mission.updatedAt)}</span>}
              onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))} />}</For></div>
        </WorkspaceSection>
      </Show>
    </PageStack>
  </BrainPage>;
}
