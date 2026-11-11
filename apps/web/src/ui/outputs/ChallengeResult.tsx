import { For, Show, createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { listChallenges, type Challenge } from "../../data/result-links";
import { formatRelative } from "../format";
import { InlineMarkdown } from "./Markdown";

/**
 * "Challenge this result" (issue #50, ADR 0012): asks a second, independent run to look for weak claims in a finished task's
 * result. What it finds are claims written by one model, shown under the result with that label; they never change the task's
 * state, evidence or verdict, and they do not count as a check. A person decides what to do with them.
 */
/** The challenges of a whole page, read with ONE query for the workspace (not one per card). */
export interface ChallengeFeed { all: () => Challenge[] | undefined; refresh: () => Promise<void> }
const FeedContext = createContext<ChallengeFeed>();

const POLL_ACTIVE_MS = 4000;
const POLL_IDLE_MS = 60_000;

/**
 * One shared reader for every ChallengeResult below it. It polls every 4 s only while a challenge is running, otherwise once a
 * minute, and not at all while the tab is hidden (it refreshes when the tab returns).
 */
export function ChallengeFeedProvider(props: { children: JSX.Element }): JSX.Element {
  const app = useApp();
  const read = createScopedRead<Challenge[]>({
    scope: app.scope,
    load: async (scope, signal) => ({ snapshot: await listChallenges(scope.workspaceId, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }),
  });
  const all = () => read.state().data;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const busy = () => (all() ?? []).some((entry) => entry.state === "requested" || entry.state === "running");
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (hidden()) return; // resumed by visibilitychange
      void read.refresh().finally(schedule);
    }, busy() ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  };
  schedule();
  const onVisible = (): void => { if (!hidden()) { void read.refresh().finally(schedule); } };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => { clearTimeout(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible); });
  const feed: ChallengeFeed = { all, refresh: async () => { await read.refresh({ force: true }); schedule(); } };
  return <FeedContext.Provider value={feed}>{props.children}</FeedContext.Provider>;
}

export function ChallengeResult(props: { workItemId: string | undefined; finished: boolean; /** Show only when a challenge exists (a collapsed card). */ quiet?: boolean; class?: string }): JSX.Element {
  const app = useApp();
  const feed = useContext(FeedContext);
  if (!feed) throw new Error("ChallengeResult needs a ChallengeFeedProvider above it.");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const eligible = () => Boolean(props.workItemId) && props.finished;
  const canWrite = () => app.canOperate();
  const mine = () => (feed.all() ?? []).filter((entry) => entry.workItemId === props.workItemId);
  const challenges = { state: () => ({ data: props.workItemId ? mine() : [] }), refresh: (_options?: { force?: boolean }) => feed.refresh() };
  const latest = () => challenges.state().data?.[0];
  const inFlight = () => latest()?.state === "requested" || latest()?.state === "running";
  async function ask(): Promise<void> {
    if (!props.workItemId || busy()) return;
    setBusy(true); setError("");
    try {
      const result = await app.run("result.challenge", { workItemId: props.workItemId });
      if (!result.accepted) throw new Error(result.detail || "The challenge was not started.");
      await challenges.refresh({ force: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The challenge was not started."); }
    finally { setBusy(false); }
  }
  const past = () => (challenges.state().data ?? []).filter((entry) => entry.state === "done" || entry.state === "failed");
  return <Show when={(!props.quiet && eligible()) || (challenges.state().data ?? []).length > 0}>
    <section class={`flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 bg-surface-gray-1 p-3 ${props.class ?? ""}`} aria-label="Challenge this result" data-testid="challenge">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h4 class="text-interface font-medium text-ink-gray-9">Challenge this result</h4>
          <p class="text-caption text-ink-gray-7">A second run reads the result and lists what looks weak. It is one model's opinion, not a check, and it never changes the verdict.</p>
        </div>
        <Show when={eligible() && canWrite()}>
          <Button size="sm" variant="outline" iconLeft="lucide-search-check" loading={busy() || inFlight()} disabled={busy() || inFlight()} onClick={() => void ask()}>
            {inFlight() ? "Reviewer is reading…" : latest() ? "Challenge again" : "Challenge this result"}
          </Button>
        </Show>
      </div>
      <Show when={error()}><p role="alert" class="text-interface text-ink-red-9">{error()}</p></Show>
      <For each={past()}>{(entry) => <article class="min-w-0 rounded-control border border-outline-gray-2 bg-surface-white p-3" data-testid="challenge-result" data-state={entry.state}>
        <p class="text-caption text-ink-gray-6">Reviewer pass {formatRelative(entry.completedAt ?? entry.requestedAt)} · independent run, same release (level {entry.independence}) · model opinion</p>
        <Show when={entry.state === "failed"}><p class="mt-1 text-interface text-ink-gray-8">The reviewer could not finish: {entry.reason ?? "unknown reason"}. Nothing about the result changed.</p></Show>
        <Show when={entry.state === "done"}>
          <Show when={entry.claims.length > 0} fallback={<p class="mt-1 text-interface text-ink-gray-8"><InlineMarkdown text={entry.summary ?? "The reviewer found nothing weak."} /></p>}>
            <p class="mt-1 text-interface font-medium text-ink-gray-9">{entry.claims.length === 1 ? "1 point to check" : `${entry.claims.length} points to check`}</p>
            <ul class="mt-1 list-disc ps-5 text-interface text-ink-gray-8" data-testid="challenge-claims"><For each={entry.claims}>{(claim) => <li><InlineMarkdown text={claim.text} /></li>}</For></ul>
          </Show>
        </Show>
      </article>}</For>
    </section>
  </Show>;
}
