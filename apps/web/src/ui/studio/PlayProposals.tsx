import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { listPlayProposals, type PlayProposal } from "../../data/play-proposals";
import { WorkspaceSection } from "../components/Domain";
import { ActionFeedback } from "../components/ActionFeedback";
import { t, tn } from "../../i18n";

/** A proposal the team's practice built says which practice and how many verified missions it came from; a one-mission proposal says nothing here. */
function proposalOrigin(proposal: PlayProposal): string | undefined {
  const view = proposal as PlayProposal & { practice?: string; sourceMissionIds?: readonly string[] };
  const practice = view.practice ?? proposal.spec.practice;
  const sources = view.sourceMissionIds?.length ?? 0;
  const parts = [practice ? t("playproposal.practice", { name: practice }) : "", sources > 0 ? tn("playproposal.sources", sources) : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Play proposals in the Library's review inbox (issue #74, ADR 0015). Each is a description of an achieved mission's confirmed plan,
 * team and success criteria. Approving it opens a draft in the Studio; nothing becomes a Play until someone validates, publishes
 * and activates that draft, so this is a first step, not a release.
 */
export function PlayProposals(): JSX.Element {
  const app = useApp();
  const [message, setMessage] = createSignal("");
  const proposals = createScopedRead<PlayProposal[]>({
    scope: app.scope,
    load: async (scope, signal) => listPlayProposals(scope.workspaceId, signal),
  });
  const canReview = () => app.identity()?.actor.scopes.includes("config:activate") ?? false;
  const items = () => proposals.state().data ?? [];
  async function decide(proposal: PlayProposal, decision: "approve" | "reject"): Promise<void> {
    setMessage("");
    try {
      const result = await app.run("play.proposal.review", { proposalId: proposal.proposalId, decision, reason: decision === "approve" ? t("mp.approved-in-the-library-review-i.cd18") : t("mp.not-worth-repeating.caed") });
      if (!result.accepted) throw new Error(result.detail || "The decision was not saved.");
      setMessage(decision === "approve" ? t("mp.a-draft-play-was-opened-in-the-s.e715") : t("mp.left-out.b1d8"));
      await proposals.refresh({ force: true });
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "The decision was not saved."); }
  }
  return <Show when={items().length > 0}>
    <WorkspaceSection title={t("mp.plays-brain-suggests.41c9")} description={t("mp.finished-missions-worth-repeatin.e4de")}>
      <ActionFeedback message={message()} />
      <div class="flex min-w-0 flex-col gap-3" data-testid="play-proposals">
        <For each={items()}>{(proposal) => <article class="min-w-0 rounded-card border border-outline-gray-2 bg-surface-white p-3" data-testid={`play-proposal-${proposal.proposalId}`} data-state={proposal.state}>
          <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 class="min-w-0 break-words text-base-medium text-ink-gray-9">{proposal.spec.title}</h3>
            <Badge size="sm" variant="subtle" theme={proposal.state === "proposed" ? "amber" : proposal.state === "approved" ? "green" : "gray"} label={proposal.state === "proposed" ? "Awaiting review" : proposal.state === "approved" ? t("mp.draft-opened.8ea3") : t("mp.left-out.e3b3")} />
          </div>
          <p class="mt-1 text-caption text-ink-gray-6">From the achieved mission "{proposal.missionTitle}" · {proposal.spec.plan.tasks.length} {proposal.spec.plan.tasks.length === 1 ? "task" : "tasks"} · {proposal.spec.team.length} {proposal.spec.team.length === 1 ? "team member" : "team members"}</p>
          <Show when={proposalOrigin(proposal)}>{(origin) => <p class="mt-1 text-caption text-ink-gray-6" data-testid="play-proposal-source">{origin()}</p>}</Show>
          <details class="mt-2 rounded-control border border-outline-gray-2 p-2">
            <summary class="cursor-pointer text-interface font-medium text-ink-gray-9">{t("mp.what-the-play-would-contain.0c14")}</summary>
            <p class="mt-2 text-interface text-ink-gray-8">{proposal.spec.intent}</p>
            <h4 class="mt-2 text-caption font-medium text-ink-gray-7">{t("mp.success-criteria.adc4")}</h4>
            <ul class="list-disc ps-5 text-interface text-ink-gray-8"><For each={proposal.spec.successCriteria}>{(criterion) => <li>{criterion}</li>}</For></ul>
            <h4 class="mt-2 text-caption font-medium text-ink-gray-7">{t("mp.plan.ae2f")}</h4>
            <ol class="list-decimal ps-5 text-interface text-ink-gray-8"><For each={proposal.spec.plan.tasks}>{(task) => <li>{task.title}<Show when={task.criteria.length}><span class="text-ink-gray-6"> · {task.criteria.length} {task.criteria.length === 1 ? "check" : "checks"}</span></Show></li>}</For></ol>
            <p class="mt-2 text-caption text-ink-gray-6">{t("mp.only-the-confirmed-plan-team-and.c4d0")}</p>
          </details>
          <Show when={proposal.state === "proposed"}>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Show when={canReview()} fallback={<p class="text-caption text-ink-gray-6">{t("mp.an-administrator-reviews-play-pr.7e8c")}</p>}>
                <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-file-pen" onClick={() => void decide(proposal, "approve")}>{t("mp.approve-and-open-a-draft.25b2")}</Button>
                <Button size="sm" variant="outline" onClick={() => void decide(proposal, "reject")}>{t("mp.not-now.e457")}</Button>
              </Show>
            </div>
          </Show>
          <Show when={proposal.state === "approved" && proposal.draftId}>{(draftId) => <p class="mt-3 text-interface"><A class="text-ink-blue-link underline" href={`/studio/Play/${encodeURIComponent(draftId())}`}>{t("mp.open-the-draft-in-the-studio.4cd2")}</A>{proposal.selfReviewed ? " · you proposed and approved this one" : ""}</p>}</Show>
        </article>}</For>
      </div>
    </WorkspaceSection>
  </Show>;
}
