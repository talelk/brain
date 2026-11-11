import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Checkbox } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import type { LibrarySummary } from "../../data/library";

/**
 * The Library's two hands-off controls (rows 47 and 49). Both are plain commands the Governor decides: whether verified
 * write-ups publish themselves, and whether the ready-made Plays are added to this workspace.
 */

/** "Publish verified write-ups automatically": on unless turned off here. Only a person who administers knowledge can change it. */
export function AutoPublishSetting(props: { summary: LibrarySummary | undefined; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const [message, setMessage] = createSignal("");
  // Workspace leads hold memory:publish. The browser identity does not carry workspace-level scopes (checking
  // `identity.actor.scopes` here disabled the switch for the workspace lead itself on the live site), so the
  // workspace role decides; the Governor still refuses anyone without the scope.
  const canChange = () => app.canAdminister();
  async function change(on: boolean): Promise<void> {
    setMessage("");
    try {
      await app.run("library.settings.set", { autoPublishKnowledge: on });
      setMessage(on ? "On. Verified write-ups now publish themselves." : "Off. Verified write-ups wait in the Review inbox until you approve them.");
      props.onChanged();
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "The setting was not saved."); }
  }
  return <div class="flex min-w-0 flex-col gap-1" data-testid="auto-publish-setting">
    <Checkbox checked={props.summary?.autoPublishKnowledge ?? true} disabled={!props.summary || !canChange()} onCheckedChange={(checked) => void change(checked === true)}
      label="Publish verified write-ups automatically" />
    <p class="m-0 ps-6 text-caption text-ink-gray-7">When you are the only reviewer, a mission you signed off writes up what it learned and publishes it as self-reviewed. It is marked, and Withdraw undoes it. Approvals, effects and tools are never published this way.</p>
    <Show when={message()}><p role="status" class="m-0 ps-6 text-caption text-ink-gray-8">{message()}</p></Show>
  </div>;
}

/** "Add starter Plays": one click adds the ready-made Plays this workspace lacks. Hidden when there is nothing to add or the person cannot. */
export function AddStarterPlays(props: { summary: LibrarySummary | undefined; onAdded: () => void; variant?: "chip" | "button" }): JSX.Element {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const installable = () => props.summary?.starterPlays.installable ?? 0;
  const allowed = () => app.identity()?.actor.scopes.includes("config:activate") ?? false;
  async function add(): Promise<void> {
    if (busy()) return;
    setBusy(true); setMessage("");
    try {
      await app.run("plays.addStarter", {});
      setMessage("Starter Plays added. They are ordinary Plays now: open one to read or edit it.");
      props.onAdded();
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "The Plays were not added."); } finally { setBusy(false); }
  }
  return <Show when={allowed() && (installable() > 0 || message())}>
    <span class="inline-flex min-w-0 flex-wrap items-center gap-2" data-testid="add-starter-plays">
      <Show when={installable() > 0}>
        <Button size={props.variant === "chip" ? "sm" : "md"} variant={props.variant === "chip" ? "outline" : "solid"} theme={props.variant === "chip" ? "gray" : "blue"} iconLeft="lucide-sparkles" loading={busy()} onClick={() => void add()}>
          {installable() === props.summary?.starterPlays.total ? "Add starter Plays" : `Add ${installable()} starter ${installable() === 1 ? "Play" : "Plays"}`}</Button>
      </Show>
      <Show when={message()}><span role="status" class="text-caption text-ink-gray-8">{message()}</span></Show>
    </span>
  </Show>;
}

/** The quiet line on Today: what Brain learned lately, or, with automatic publishing off, that write-ups wait and one click publishes them all. */
export function KnowledgeLine(props: { summary: LibrarySummary | undefined; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const waiting = () => props.summary?.awaitingReview ?? 0;
  const learned = () => props.summary?.learnedThisWeek ?? 0;
  const canApprove = () => app.canAdminister();
  async function approve(): Promise<void> {
    setBusy(true);
    try { await app.run("knowledge.approveVerified", {}); props.onChanged(); } finally { setBusy(false); }
  }
  const library = () => `/w/${app.workspaceId()}/knowledge/review`;
  return <Show when={props.summary && (learned() > 0 || (waiting() > 0 && !props.summary.autoPublishKnowledge))}>
    <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-interface text-ink-gray-7" data-testid="knowledge-line">
      <span class="lucide-brain size-4 shrink-0" aria-hidden="true" />
      <Show when={learned() > 0}><span>Brain learned {learned()} {learned() === 1 ? "thing" : "things"} this week{props.summary!.learnedAutomatically > 0 ? ` (${props.summary!.learnedAutomatically} on its own)` : ""}.</span></Show>
      <Show when={waiting() > 0 && !props.summary!.autoPublishKnowledge}><span>{waiting()} write-{waiting() === 1 ? "up waits" : "ups wait"} for your OK.</span>
        <Show when={canApprove()}><Button variant="ghost" size="sm" loading={busy()} onClick={() => void approve()}>Approve all verified</Button></Show></Show>
      <Button variant="ghost" size="sm" iconRight="lucide-arrow-right" onClick={() => void navigate(library())}>See what</Button>
    </p>
  </Show>;
}
