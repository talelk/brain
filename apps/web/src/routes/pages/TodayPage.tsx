import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Card } from "@talelk/newui-molecules";
import { useApp } from "../../ui/app-context";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { AttentionRows, attentionHref } from "../../ui/components/AttentionDrawer";
import { NeedsYouQueue } from "../../ui/components/NeedsYouQueue";
import { ATTENTION_CHANGED, blockingCount, createAttentionRead } from "../../ui/attention";
import { missionHref } from "../../ui/mission-links";
import { formatRelative } from "../../ui/format";
import { PlainSummary } from "../../ui/viz/PlainSummary";
import { createStartController, StartFields } from "../../ui/start/StartBox";
import { blockedBy, TodaySetup } from "../../ui/components/TodaySetup";
import { createReadiness } from "../../ui/components/OperationalChecklist";

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
  /** After an inline decision: every attention read (this one and the bell) and the missions list (their versions) re-read. */
  const changed = () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); void start.missions.refresh({ force: true }); };
  const items = () => attention.state().data ?? [];
  const waitingItems = () => items().filter((item) => item.kind !== "result-ready");
  const readyItems = () => items().filter((item) => item.kind === "result-ready");
  const recent = () => [...(start.missions.state().data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const running = () => (start.missions.state().data ?? []).reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  const summary = () => {
    const waiting = blockingCount(items());
    return `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you, ${running()} ${running() === 1 ? "agent" : "agents"} working.`;
  };
  return <BrainPage title="Today" description="Say what you want done. Brain drafts a plan and waits for your OK before anything runs.">
    <PageStack>
      {/* Anything that blocks work leads the page (the box stays one scroll away); an empty queue leaves the box first. */}
      <Show when={waitingItems().length}>
        <PlainSummary icon={blockingCount(items()) ? "lucide-bell-ring" : "lucide-circle-check"}>{summary()}</PlainSummary>
        <WorkspaceSection title="Needs you" description="Decisions that block work, approvals first. Decide each one right here.">
          <NeedsYouQueue items={waitingItems()} missions={start.missions.state().data ?? []} onChanged={changed} />
        </WorkspaceSection>
      </Show>
      <TodaySetup readiness={readiness} />
      <Card padding="lg" class="flex min-w-0 flex-col gap-4" aria-label="Start a mission" data-blocked={blocked() ? "true" : "false"}>
        <StartFields start={start} large sample disabled={blocked()} onSubmit={() => void start.start()} />
        <Show when={start.error()}><p role="alert" class="text-interface text-ink-red-7">{start.error()}</p></Show>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-caption text-ink-gray-7">{blocked() ? "Blocked until setup above is done." : "Nothing runs until you confirm the plan."}</p>
          <Button variant="solid" theme="blue" iconLeft="lucide-flag" loading={start.busy()} disabled={start.busy() || !start.canStart() || blocked()} onClick={() => void start.start()}>Start</Button>
        </div>
      </Card>
      <Show when={!waitingItems().length && (items().length || recent().length)}>
        <PlainSummary icon="lucide-circle-check">{summary()}</PlainSummary>
      </Show>
      <Show when={readyItems().length}>
        <WorkspaceSection title="Results ready" description="Finished work to look at when you like. Nothing is waiting on it.">
          <AttentionRows items={readyItems()} onOpen={(item) => void navigate(attentionHref(item))} />
        </WorkspaceSection>
      </Show>
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
