import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { Mission, PlayView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { missionHref } from "../mission-links";
import { formatDateTime } from "../format";
import { fromMissions, repeatHref, sourceConstraint } from "./reuse";
import type { ReuseCandidate } from "./reuse";

type Envelope<T> = { snapshot: { items: T[] }; asOf: string; sourceWatermark: number };
/** Search only earns its place once the list is long enough to need it. */
const SEARCH_FROM = 6;

/**
 * The one way to start a mission (#47): a sentence, optionally seeded by a play
 * or a previous mission. Today and the New mission dialog both render this
 * controller, so they behave identically on every open. No budget is sent: the
 * Governor applies the documented default.
 */
export function createStartController() {
  const app = useApp();
  const navigate = useNavigate();
  const plays = createScopedRead<PlayView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<PlayView>>({ queryType: "plays.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const missions = createScopedRead<Mission[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<Mission>>({ queryType: "missions.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const [intent, setIntent] = createSignal("");
  const [playId, setPlayId] = createSignal("");
  const [source, setSource] = createSignal<ReuseCandidate>();
  const [title, setTitle] = createSignal("");
  const [startMode, setStartMode] = createSignal("auto");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [attempted, setAttempted] = createSignal(false);
  const playList = () => plays.state().data ?? [];
  const play = () => playList().find((candidate) => candidate.playId === playId());
  const candidates = createMemo(() => fromMissions(missions.state().data ?? [], playList()));
  const firstLine = () => intent().trim().split("\n")[0] ?? "";
  /** The title a person did not type: the play's or source's own, or the first words of the sentence. */
  const derivedTitle = () => {
    if (!firstLine() && play()) return play()!.title;
    if (!firstLine() && source()) return source()!.title;
    const sentence = firstLine().replace(/[.!?]+$/u, "");
    return sentence.length <= 60 ? sentence : `${sentence.slice(0, 60).replace(/\s+\S*$/u, "")}…`;
  };
  const needsSentence = () => !playId() && !source();
  const problem = () => (needsSentence() && !intent().trim() ? "Say in a sentence what you want done." : undefined);
  const shownProblem = () => (attempted() ? problem() : undefined);
  const pickPlay = (id: string) => { setPlayId(playId() === id ? "" : id); if (playId()) setSource(undefined); };
  const pickSource = (candidate: ReuseCandidate | undefined) => { setSource(candidate); if (candidate) setPlayId(""); };
  async function start(): Promise<void> {
    setAttempted(true);
    if (problem() || busy()) return;
    setBusy(true); setError("");
    try {
      const typed = intent().trim();
      const from = source();
      const payload = {
        title: title().trim() || derivedTitle() || "New mission",
        autoStart: startMode() === "auto",
        ...(playId() ? { playId: playId(), ...(typed ? { intent: typed } : {}) }
          : from ? { intent: typed || from.intent, successCriteria: typed ? [`Done: ${firstLine()}`] : [...from.successCriteria], constraints: [sourceConstraint(from)] }
          // The Governor needs at least one criterion; the sentence is the first, editable in the plan.
          : { intent: typed, successCriteria: [`Done: ${firstLine()}`] }),
      };
      const receipt = await app.run("mission.create", payload);
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The mission was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, "plan"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The mission was not started."); } finally { setBusy(false); }
  }
  return { intent, setIntent, playId, play, playList, pickPlay, source, pickSource, candidates, title, setTitle, startMode, setStartMode, busy, error, shownProblem, derivedTitle, start,
    canStart: () => app.canDispatch(), workspaceId: () => app.workspaceId(), plays, missions };
}
export type StartController = ReturnType<typeof createStartController>;

/** The sentence box, the play chips, the reuse chips and the "more options" disclosure. */
export function StartFields(props: { start: StartController; large?: boolean; onSubmit?: () => void }): JSX.Element {
  const navigate = useNavigate();
  const s = props.start;
  const [panel, setPanel] = createSignal<"" | "previous" | "repeat">("");
  const [filter, setFilter] = createSignal("");
  const matching = () => { const needle = filter().trim().toLowerCase(); return s.candidates().filter((c) => !needle || `${c.title} ${c.intent} ${c.provenance}`.toLowerCase().includes(needle)); };
  const toggle = (next: "previous" | "repeat") => { setPanel(panel() === next ? "" : next); setFilter(""); };
  const chosen = () => s.play()?.title ?? s.source()?.title;
  const clear = () => { if (s.playId()) s.pickPlay(s.playId()); s.pickSource(undefined); };
  const choose = (candidate: ReuseCandidate) => {
    if (panel() === "repeat") { void navigate(repeatHref(s.workspaceId(), candidate)); return; }
    s.pickSource(candidate); setPanel("");
  };
  const chip = (label: string, icon: string, pressed: boolean, onClick: () => void, extra?: { expanded?: boolean }) =>
    <Button variant={pressed ? "subtle" : "outline"} theme={pressed ? "blue" : "gray"} size="sm" iconLeft={icon} aria-pressed={extra?.expanded === undefined ? pressed : undefined} aria-expanded={extra?.expanded} onClick={onClick}>{label}</Button>;
  return <div class="flex min-w-0 flex-col gap-3">
    <Textarea label="What do you want done?" value={s.intent()} onInput={(event) => s.setIntent(event.currentTarget.value)} error={s.shownProblem()} rows={props.large ? 3 : 2}
      required={!s.playId() && !s.source()} placeholder="For example: summarise this week's support tickets and draft replies"
      onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); props.onSubmit?.(); } }} />
    <Show when={chosen()}>{(name) => <p class="flex min-w-0 flex-wrap items-center gap-2 text-interface text-ink-gray-8" data-testid="start-seed">
      <span class="lucide-corner-down-right size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{s.source() ? "Starting from the earlier mission" : "Starting from the play"} <strong>{name()}</strong>. {s.intent().trim() ? "Your sentence replaces its goal." : "Add a sentence to change the goal, or just start."}</span>
      <Button variant="ghost" size="sm" iconLeft="lucide-x" onClick={clear}>Remove</Button>
    </p>}</Show>
    <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" aria-label="Start from something ready">
      <Show when={s.playList().length}>
        <div class="flex min-w-0 flex-wrap items-center gap-2"><span class="text-caption text-ink-gray-7">Plays</span>
          <For each={s.playList()}>{(play) => chip(play.title, "lucide-book-open-check", s.playId() === play.playId, () => s.pickPlay(play.playId))}</For></div>
      </Show>
      <div class="flex min-w-0 flex-wrap items-center gap-2"><span class="text-caption text-ink-gray-7">Reuse</span>
        {chip("Start from a previous mission", "lucide-history", panel() === "previous", () => toggle("previous"), { expanded: panel() === "previous" })}
        {chip("Repeat this", "lucide-repeat", panel() === "repeat", () => toggle("repeat"), { expanded: panel() === "repeat" })}
      </div>
    </fieldset>
    <Show when={panel()}>
      <section class="flex min-w-0 flex-col gap-2 rounded-lg border border-outline-gray-2 p-3" aria-label={panel() === "repeat" ? "Choose a mission to repeat" : "Choose a previous mission"}>
        <p class="text-caption text-ink-gray-7">{panel() === "repeat" ? "Pick a finished mission to run again on a schedule." : "Pick a finished mission. Its goal and criteria seed the new one, and it names the source."}</p>
        <Show when={s.candidates().length >= SEARCH_FROM}><TextInput label="Search finished missions" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></Show>
        <Show when={s.candidates().length} fallback={<p class="text-interface text-ink-gray-8" role="status">Nothing to reuse yet. Missions you finish will appear here, with when they were last verified.</p>}>
          <Show when={matching().length} fallback={<p class="text-interface text-ink-gray-8" role="status">No finished mission matches that search.</p>}>
            <ul class="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0">
              <For each={matching()}>{(candidate) => <li><button type="button" class="brain-queue-row w-full" aria-label={`${panel() === "repeat" ? "Repeat" : "Start from"} ${candidate.title}`} onClick={() => choose(candidate)}>
                <span class="lucide-flag size-5 shrink-0 text-ink-gray-6" aria-hidden="true" />
                <span class="min-w-0 text-left"><span class="block break-words text-base-medium">{candidate.title}</span>
                  <span class="block break-words text-caption text-ink-gray-7">{candidate.provenance} · {candidate.lastVerifiedAt ? `Last verified ${formatDateTime(candidate.lastVerifiedAt)}` : "Not verified"}</span></span>
              </button></li>}</For>
            </ul>
          </Show>
        </Show>
      </section>
    </Show>
    <details class="text-interface"><summary class="cursor-pointer text-ink-gray-8">More options</summary>
      <div class="mt-3 flex min-w-0 flex-col gap-3">
        <TextInput label="Title (optional)" value={s.title()} onInput={(event) => s.setTitle(event.currentTarget.value)} placeholder={s.derivedTitle() || "Named for you from your sentence"} />
        <Select label="Starting tasks" description="Automatic starts each ready task once the plan is confirmed. Otherwise you start every task yourself." value={s.startMode()}
          options={[{ value: "auto", label: "Start tasks automatically" }, { value: "ask", label: "Ask me before each task" }]} onValueChange={(value) => s.setStartMode(value ?? "auto")} />
      </div>
    </details>
  </div>;
}
