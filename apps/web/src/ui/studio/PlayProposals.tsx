import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { listPlayProposals, type PlayProposal } from "../../data/play-proposals";
import { WorkspaceSection } from "../components/Domain";
import { ActionFeedback } from "../components/ActionFeedback";

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
    refreshMs: 5000,
  });
  const canReview = () => app.identity()?.actor.scopes.includes("config:activate") ?? false;
  const items = () => proposals.state().data ?? [];
  async function decide(proposal: PlayProposal, decision: "approve" | "reject"): Promise<void> {
    setMessage("");
    try {
      const result = await app.run("play.proposal.review", { proposalId: proposal.proposalId, decision, reason: decision === "approve" ? "Approved in the Library review inbox" : "Not worth repeating" });
      if (!result.accepted) throw new Error(result.detail || "The decision was not saved.");
      setMessage(decision === "approve" ? "A draft Play was opened in the Studio. Nothing is active yet." : "Left out.");
      await proposals.refresh({ force: true });
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "The decision was not saved."); }
  }
  return <Show when={items().length > 0}>
    <WorkspaceSection title="Plays Brain suggests" description="Finished missions worth repeating, as a reusable team and plan. Approving opens a draft in the Studio; it is not active until you publish and activate it.">
      <ActionFeedback message={message()} />
      <div class="flex min-w-0 flex-col gap-3" data-testid="play-proposals">
        <For each={items()}>{(proposal) => <article class="min-w-0 rounded-card border border-outline-gray-2 bg-surface-white p-3" data-testid={`play-proposal-${proposal.proposalId}`} data-state={proposal.state}>
          <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 class="min-w-0 break-words text-base-medium text-ink-gray-9">{proposal.spec.title}</h3>
            <Badge size="sm" variant="subtle" theme={proposal.state === "proposed" ? "amber" : proposal.state === "approved" ? "green" : "gray"} label={proposal.state === "proposed" ? "Awaiting review" : proposal.state === "approved" ? "Draft opened" : "Left out"} />
          </div>
          <p class="mt-1 text-caption text-ink-gray-6">From the achieved mission "{proposal.missionTitle}" · {proposal.spec.plan.tasks.length} {proposal.spec.plan.tasks.length === 1 ? "task" : "tasks"} · {proposal.spec.team.length} {proposal.spec.team.length === 1 ? "team member" : "team members"}</p>
          <details class="mt-2 rounded-control border border-outline-gray-2 p-2">
            <summary class="cursor-pointer text-interface font-medium text-ink-gray-9">What the Play would contain</summary>
            <p class="mt-2 text-interface text-ink-gray-8">{proposal.spec.intent}</p>
            <h4 class="mt-2 text-caption font-medium text-ink-gray-7">Success criteria</h4>
            <ul class="list-disc ps-5 text-interface text-ink-gray-8"><For each={proposal.spec.successCriteria}>{(criterion) => <li>{criterion}</li>}</For></ul>
            <h4 class="mt-2 text-caption font-medium text-ink-gray-7">Plan</h4>
            <ol class="list-decimal ps-5 text-interface text-ink-gray-8"><For each={proposal.spec.plan.tasks}>{(task) => <li>{task.title}<Show when={task.criteria.length}><span class="text-ink-gray-6"> · {task.criteria.length} {task.criteria.length === 1 ? "check" : "checks"}</span></Show></li>}</For></ol>
            <p class="mt-2 text-caption text-ink-gray-6">Only the confirmed plan, team and criteria. No notes, messages or documents are copied.</p>
          </details>
          <Show when={proposal.state === "proposed"}>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Show when={canReview()} fallback={<p class="text-caption text-ink-gray-6">An administrator reviews Play proposals.</p>}>
                <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-file-pen" onClick={() => void decide(proposal, "approve")}>Approve and open a draft</Button>
                <Button size="sm" variant="outline" onClick={() => void decide(proposal, "reject")}>Not now</Button>
              </Show>
            </div>
          </Show>
          <Show when={proposal.state === "approved" && proposal.draftId}>{(draftId) => <p class="mt-3 text-interface"><A class="text-ink-blue-link underline" href={`/studio/Play/${encodeURIComponent(draftId())}`}>Open the draft in the Studio</A>{proposal.selfReviewed ? " · you proposed and approved this one" : ""}</p>}</Show>
        </article>}</For>
      </div>
    </WorkspaceSection>
  </Show>;
}
