import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { practicesRead, type Practice, type PracticesView } from "../../data/engine";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "./Domain";
import { StatusBadge } from "./StatusBadge";
import { t } from "../../i18n";

/** One kind of work the team does: its Plays, its proposals, and the one action that drafts a Play from verified missions. */
function PracticeCard(props: { practice: Practice; onProposed: () => Promise<void> }): JSX.Element {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [error, setError] = createSignal("");
  async function propose(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError(""); setDone(false);
    try {
      const receipt = await app.run("play.proposeFromMissions", { practice: props.practice.id });
      if (!receipt.accepted) throw new Error(receipt.detail);
      setDone(true);
      await props.onProposed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("decision.refused")); } finally { setBusy(false); }
  }
  return <article class="flex min-w-0 flex-col gap-1.5 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-practice={props.practice.id}>
    <h3 class="m-0 break-words text-interface font-medium text-ink-gray-9">{props.practice.title}</h3>
    <p class="m-0 break-words text-caption text-ink-gray-7">{props.practice.description}</p>
    <p class="m-0 break-words text-caption text-ink-gray-6">{props.practice.plays.length ? t("practices.plays", { plays: props.practice.plays.join(", ") }) : t("practices.noPlays")}</p>
    <Show when={props.practice.proposals.length > 0}><ul class="m-0 flex list-none flex-wrap gap-2 p-0 text-caption text-ink-gray-7"><For each={props.practice.proposals}>{(proposal) => <li class="inline-flex items-center gap-1">{proposal.playId} <StatusBadge kind="decision" status={proposal.state} /></li>}</For></ul></Show>
    <div class="mt-1 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" iconLeft="lucide-sparkles" loading={busy()} disabled={busy() || !props.practice.canPropose || !app.canDispatch()} onClick={() => void propose()}>{t("practices.propose")}</Button>
      <Show when={!props.practice.canPropose}><span class="text-caption text-ink-gray-6">{t("practices.notEnough")}</span></Show>
    </div>
    <Show when={done()}><p role="status" class="m-0 text-caption text-ink-green-8" data-practice-proposed>{t("practices.proposed")} <A class="font-medium text-ink-blue-8 underline" href={`/w/${app.workspaceId()}/knowledge/review`}>{t("practices.openReview")}</A></p></Show>
    <Show when={error()}><p role="alert" class="m-0 text-caption text-ink-red-8">{error()}</p></Show>
  </article>;
}

/** The team's practices (`practices.list`), with the Play each already has and what is waiting for review. */
export function Practices(): JSX.Element {
  const app = useApp();
  const read = createScopedRead<PracticesView>({ scope: app.scope, live: true, load: (scope, signal) => practicesRead(scope.workspaceId, signal) });
  return <WorkspaceSection title={t("practices.title")} description={t("practices.description")}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("practices.title")} emptyDescription={t("practices.empty")}>
      <Show when={read.state().data}>{(data) => <div class="flex min-w-0 flex-col gap-3" data-practices>
        <p class="m-0 text-interface text-ink-gray-7">{t("practices.ready", { eligible: data().eligibleMissions, min: data().minMissions })}</p>
        <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"><For each={data().practices}>{(practice) => <PracticeCard practice={practice} onProposed={() => read.refresh()} />}</For></div>
      </div>}</Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
