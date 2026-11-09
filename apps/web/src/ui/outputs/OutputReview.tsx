import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import type { ExecutionLink, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { ActionFeedback } from "../components/ActionFeedback";
import { missionHref } from "../mission-links";
import type { ArtifactHistory } from "../../data/exec-outputs";
import { verificationSummary } from "./OutputHistory";
import { createHandoffNeed, HandoffSheet } from "../components/HandoffStep";

/** What a work item needs from the person looking at its output. */
export function reviewStateOf(item: WorkItem | undefined): "review" | "done" | "other" {
  if (!item) return "other";
  return item.state === "review" ? "review" : item.state === "done" ? "done" : "other";
}

/** The newest evidence bundle that carries an independent "verified" verdict for this artifact. */
function verifiedBundle(history: ArtifactHistory | undefined): string | undefined {
  return history?.history.find((version) => version.verification?.outcome === "verified")?.bundleDigest;
}

/**
 * The one review action for an output: Accept moves its work item to Done on
 * the independently verified evidence bundle, Request changes sends it back to
 * In progress with a reason. Both are the existing `workItem.transition`
 * command (the same one the mission Plan tab uses); when the item is not in
 * review or has no verified evidence yet, the bar links to the plan tab where
 * that move happens instead of offering a refused action.
 */
export function OutputReview(props: {
  item: WorkItem | undefined;
  link: ExecutionLink | undefined;
  history: ArtifactHistory | undefined;
  onChanged: () => void;
}): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [asking, setAsking] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [handingOff, setHandingOff] = createSignal(false);
  const handoff = createHandoffNeed(() => props.item);
  const evidence = () => verifiedBundle(props.history);
  const verdict = () => verificationSummary(props.history);
  const canMove = () => app.canDispatch() && props.item !== undefined && reviewStateOf(props.item) === "review";
  const planHref = () => (props.link ? missionHref(app.workspaceId(), props.link.missionId, "plan") : "");

  async function move(state: "done" | "in-progress"): Promise<void> {
    const item = props.item;
    if (!item) return;
    setBusy(true);
    setError("");
    try {
      const result = await app.run(
        "workItem.transition",
        {
          workItemId: item.workItemId,
          state,
          ...(state === "done" && evidence() ? { evidenceDigest: evidence() } : {}),
          ...(state === "in-progress" ? { reason: reason().trim() } : {}),
        },
        { expectedVersion: item.version },
      );
      if (result.accepted) {
        setAsking(false);
        setReason("");
        props.onChanged();
      } else setError(result.detail || "The move was refused");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The move was refused");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={props.item} fallback={<Alert0 text="This output is not tied to a work item, so there is nothing to accept here." />}>
      {(item) => (
        <div class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 bg-surface-gray-1 p-3" data-testid="outputs-review">
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-0 text-base-medium text-ink-gray-9">{item().title}</span>
            <Show when={reviewStateOf(item()) === "review"}>
              <Badge size="sm" theme="amber" label="Needs review" />
            </Show>
            <Show when={reviewStateOf(item()) === "done"}>
              <Badge size="sm" theme="green" label="Accepted" />
            </Show>
          </div>
          <Show
            when={canMove()}
            fallback={
              <p class="text-caption text-ink-gray-7">
                {reviewStateOf(item()) === "done"
                  ? "This work is already marked Done."
                  : "This work item is not waiting for review yet. Moves happen on its mission's plan."}{" "}
                <Show when={planHref()}>
                  <a class="text-ink-blue-7 underline focus-visible:focus-ring" href={planHref()} onClick={(event) => { event.preventDefault(); void navigate(planHref()); }}>
                    Open the work item
                  </a>
                </Show>
              </p>
            }
          >
            <Show when={!evidence()}>
              <p class="text-caption text-ink-gray-7">
                Accepting needs an independent check first ({verdict().label.toLowerCase()} so far). You can still ask for changes.
              </p>
            </Show>
            <Show when={handoff.required()}>
              <p class="text-caption text-ink-gray-7">Other tasks wait on this one, so accepting first asks you to hand off to the next tasks.</p>
            </Show>
            <Show
              when={asking()}
              fallback={
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check" disabled={!evidence() || busy()} loading={busy()} onClick={() => { if (handoff.required()) setHandingOff(true); else void move("done"); }}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" iconLeft="lucide-message-square-warning" disabled={busy()} onClick={() => setAsking(true)}>
                    Request changes
                  </Button>
                </div>
              }
            >
              <TextInput label="What should change?" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} />
              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="solid" theme="blue" disabled={!reason().trim() || busy()} loading={busy()} onClick={() => void move("in-progress")}>
                  Send back for changes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
              </div>
            </Show>
          </Show>
          <ActionFeedback tone="error" message={error()} />
          <HandoffSheet item={item()} open={handingOff()} onClose={() => setHandingOff(false)} onSubmitted={async () => { setHandingOff(false); await handoff.refresh(); await move("done"); }} />
        </div>
      )}
    </Show>
  );
}

function Alert0(props: { text: string }): JSX.Element {
  return <p class="text-caption text-ink-gray-7">{props.text}</p>;
}
