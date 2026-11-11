import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { listPlayProposals, type PlayProposal } from "../../data/play-proposals";

/**
 * "Propose as Play" on an achieved mission (issue #74, ADR 0015): turns what worked, its confirmed plan, team and success criteria,
 * into a reviewable proposal in the Library's review inbox. Nothing is offered for a cancelled or unfinished mission.
 */
export function ProposePlay(props: { missionId: string; achieved: boolean }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const proposals = createScopedRead<PlayProposal[]>({ scope: app.scope, load: async (scope, signal) => listPlayProposals(scope.workspaceId, signal), refreshMs: 10_000 });
  const existing = () => (proposals.state().data ?? []).find((entry) => entry.missionId === props.missionId);
  async function propose(): Promise<void> {
    setBusy(true); setError("");
    try {
      const result = await app.run("play.propose", { missionId: props.missionId });
      if (!result.accepted) throw new Error(result.detail || "The proposal was not created.");
      await proposals.refresh({ force: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The proposal was not created."); }
    finally { setBusy(false); }
  }
  return <Show when={props.achieved}>
    <div class="flex min-w-0 flex-wrap items-center gap-3 rounded-control border border-outline-gray-2 bg-surface-gray-1 px-3 py-2 text-interface text-ink-gray-8" data-testid="propose-play">
      <span class="lucide-book-open-check size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
      <p class="min-w-0 flex-1">
        {existing() ? existing()!.state === "proposed" ? "This mission is proposed as a Play. It waits in the Library's review inbox." : existing()!.state === "approved" ? "This mission became a draft Play." : "You left this mission's Play proposal out." : "This worked. Turn its plan, team and success criteria into a Play others can start from, after a person reviews it."}
      </p>
      <Show when={!existing()} fallback={<Button size="sm" variant="outline" onClick={() => void navigate(`/w/${app.workspaceId()}/knowledge/review`)}>Open the review inbox</Button>}>
        <Show when={app.canOperate()}><Button size="sm" variant="outline" iconLeft="lucide-book-open-check" loading={busy()} disabled={busy()} onClick={() => void propose()}>Propose as Play</Button></Show>
      </Show>
      <Show when={error()}><p role="alert" class="basis-full text-ink-red-9">{error()}</p></Show>
    </div>
  </Show>;
}
