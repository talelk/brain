import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { PlayView, StandingTeam } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { missionHref } from "../mission-links";
import { formatDateTime } from "../format";
import { reuseSearch } from "../../data/reuse";
import { standingTeamsRead } from "../../data/standing-teams";
import { librarySummary, type LibrarySummary } from "../../data/library";
import { AddStarterPlays } from "../components/LibraryControls";
import { fromMissions, fromReuseItems, repeatHref, sourceConstraint } from "./reuse";
import type { ReuseCandidate } from "./reuse";
import { deriveMissionTitle } from "./title";

type Envelope<T> = { snapshot: { items: T[] }; asOf: string; sourceWatermark: number };
/** What "Try a sample goal" starts: plain, read-only and small enough to finish in a minute or two. */
export const SAMPLE_GOAL = {
  title: "Sample goal: check this install",
  intent: "Write a short plain-language note, three to five sentences, that explains to a new colleague what Brain does and that a person confirms the plan before anything runs.",
  successCriteria: ["The note is three to five sentences long", "The note says what Brain does in plain words", "The note says a person confirms the plan before anything runs"],
};
/** Search only earns its place once the list is long enough to need it. */
const SEARCH_FROM = 6;
/** Plays shown as chips on a phone before the rest sit behind "N more Plays". */
const PHONE_PLAYS = 3;

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
  /** The Library's counts: whether starter Plays can be added, and what Brain learned lately (Today's quiet line). */
  const library = createScopedRead<LibrarySummary>({
    scope: app.scope,
    load: async (scope, signal) => librarySummary(scope.workspaceId, signal),
  });
  const reloadLibrary = () => { void plays.refresh({ force: true }); void library.refresh({ force: true }); };
  const missions = app.useMissions();
  const [intent, setIntent] = createSignal("");
  const [playId, setPlayId] = createSignal("");
  /** A standing team a Play is started with (ADR 0056); its members are copied into the mission's plan. Empty keeps the Play's own team. */
  const [teamId, setTeamId] = createSignal("");
  const [source, setSource] = createSignal<ReuseCandidate>();
  const [title, setTitle] = createSignal("");
  const [startMode, setStartMode] = createSignal("auto");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [attempted, setAttempted] = createSignal(false);
  const playList = () => plays.state().data ?? [];
  const play = () => playList().find((candidate) => candidate.playId === playId());
  /** Finished missions a schedule can repeat. */
  const candidates = createMemo(() => fromMissions(missions.state().data ?? [], playList()));
  const firstLine = () => intent().trim().split("\n")[0] ?? "";
  /** The title a person did not type: the picked Play's or earlier mission's title leads, then the sentence tidied. */
  const derivedTitle = () => deriveMissionTitle(firstLine(), play()?.title ?? source()?.title);
  const needsSentence = () => !playId() && !source();
  const problem = () => (needsSentence() && !intent().trim() ? t("start.problem") : undefined);
  const shownProblem = () => (attempted() ? problem() : undefined);
  const pickPlay = (id: string) => { setPlayId(playId() === id ? "" : id); setTeamId(""); if (playId()) setSource(undefined); };
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
        ...(playId() ? { playId: playId(), ...(teamId() ? { standingTeamId: teamId() } : {}), ...(typed ? { intent: typed } : {}) }
          : from ? { intent: typed || from.intent, successCriteria: typed ? [`Done: ${firstLine()}`] : [...from.successCriteria], constraints: [sourceConstraint(from)] }
          // The Governor needs at least one criterion; the sentence is the first, editable in the plan.
          : { intent: typed, successCriteria: [`Done: ${firstLine()}`] }),
      };
      const receipt = await app.run("mission.create", payload);
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The mission was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, "plan"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The mission was not started."); } finally { setBusy(false); }
  }
  /** The sample goal (#48): a small real mission on the shipped general workflow, so finishing it proves the install end to end. */
  async function startSample(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const receipt = await app.run("mission.create", { ...SAMPLE_GOAL, autoStart: true });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The sample goal was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, "plan"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The sample goal was not started."); } finally { setBusy(false); }
  }
  return { startSample, intent, setIntent, playId, teamId, setTeamId, play, playList, pickPlay, source, pickSource, candidates, title, setTitle, startMode, setStartMode, busy, error, shownProblem, derivedTitle, start,
    canStart: () => app.canDispatch(), workspaceId: () => app.workspaceId(), plays, missions, library, reloadLibrary, listMissions: () => missions.state().data ?? [] };
}
export type StartController = ReturnType<typeof createStartController>;

/**
 * "Use a standing team" for a picked Play (ADR 0056): the team's members are copied into the mission's plan in place of the Play's own team,
 * and a Play that runs a coordinator needs a team that names one. Nothing shows when the workspace has no standing team.
 */
function StartTeamChoice(props: { start: StartController; disabled?: boolean | undefined }): JSX.Element {
  const app = useApp();
  const teams = createScopedRead<StandingTeam[]>({ scope: app.scope, load: async (scope, signal) => standingTeamsRead(scope.workspaceId, signal) });
  const active = () => (teams.state().data ?? []).filter((team) => team.state === "active");
  const NONE = "__none";
  return <Show when={active().length}>
    <div class="flex min-w-0 flex-col gap-1" data-testid="start-standing-team">
      <Select label={t("start.team.label")} description={t("start.team.hint")} value={props.start.teamId() || NONE} disabled={props.disabled}
        options={[{ value: NONE, label: t("start.team.own") }, ...active().map((team) => ({ value: team.standingTeamId, label: team.name, description: team.coordinatorMemberId ? t("start.team.with-coordinator", { n: team.members.length }) : t("teams.members", { n: team.members.length }) }))]}
        onValueChange={(value) => props.start.setTeamId(!value || value === NONE ? "" : value)} />
    </div>
  </Show>;
}

/** The sentence box, the play chips, the reuse chips and the "more options" disclosure. */
export function StartFields(props: { start: StartController; large?: boolean; /** One tight row of chips under the box, for Today where the box leads. */ compact?: boolean; onSubmit?: () => void; /** Blocks the box (setup is not done); chips stay visible but cannot be used. */ disabled?: boolean; /** Offers the "Try a sample goal" chip. */ sample?: boolean; /** Phone only: the primary action sits beside the box in a bar fixed to the bottom of the screen (the box leaves the card). */ dockAction?: JSX.Element }): JSX.Element {
  const navigate = useNavigate();
  const s = props.start;
  const [panel, setPanel] = createSignal<"" | "previous" | "repeat">("");
  const [filter, setFilter] = createSignal("");
  /** What the reuse index is asked: the search field, else the sentence already typed in the box. */
  const [asked, setAsked] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const text = (filter().trim() || s.intent().trim());
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => setAsked(text), 250);
  });
  onCleanup(() => { if (timer) clearTimeout(timer); });
  const [found] = createResource(() => (panel() === "previous" && asked() ? { workspaceId: s.workspaceId(), text: asked() } : false), async (key) => {
    try { return { items: (await reuseSearch(key.workspaceId, key.text)).snapshot, failed: false }; } catch { return { items: [], failed: true }; }
  });
  const previous = () => fromReuseItems(found()?.items ?? [], s.listMissions());
  const repeatable = () => { const needle = filter().trim().toLowerCase(); return s.candidates().filter((c) => !needle || `${c.title} ${c.intent} ${c.provenance}`.toLowerCase().includes(needle)); };
  const toggle = (next: "previous" | "repeat") => { setPanel(panel() === next ? "" : next); setFilter(""); };
  const chosen = () => s.play()?.title ?? s.source()?.title;
  const clear = () => { if (s.playId()) s.pickPlay(s.playId()); s.pickSource(undefined); };
  const choose = (candidate: ReuseCandidate) => {
    if (panel() === "repeat") { void navigate(repeatHref(s.workspaceId(), candidate)); return; }
    s.pickSource(candidate); setPanel("");
  };
  const candidateRow = (candidate: ReuseCandidate) => <li><button type="button" class="brain-queue-row w-full" aria-label={`${panel() === "repeat" ? "Repeat" : "Start from"} ${candidate.title}`} onClick={() => choose(candidate)}>
    <span class="lucide-flag size-5 shrink-0 text-ink-gray-6" aria-hidden="true" />
    <span class="min-w-0 text-start"><span class="block break-words text-base-medium">{candidate.title}</span>
      <span class="block break-words text-caption text-ink-gray-7">{candidate.provenance} · {candidate.lastVerifiedAt ? `Last verified ${formatDateTime(candidate.lastVerifiedAt)}` : "Not verified"}</span></span>
  </button></li>;
  const chip = (label: string, icon: string, pressed: boolean, onClick: () => void, extra?: { expanded?: boolean }) =>
    <Button variant={pressed ? "subtle" : "outline"} theme={pressed ? "blue" : "gray"} size="sm" iconLeft={icon} aria-pressed={extra?.expanded === undefined ? pressed : undefined} aria-expanded={extra?.expanded} disabled={props.disabled} onClick={onClick}>{label}</Button>;
  return <div class="flex min-w-0 flex-col gap-3">
    <div class={props.dockAction ? "brain-start-dock" : "contents"}>
      <Textarea label={t("start.label")} value={s.intent()} onInput={(event) => s.setIntent(event.currentTarget.value)} error={s.shownProblem()} rows={props.large && !props.compact ? 3 : 2} disabled={props.disabled}
      required={!s.playId() && !s.source()} placeholder={t("start.placeholder")}
      onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); props.onSubmit?.(); } }} />
      {props.dockAction}
    </div>
    <Show when={chosen()}>{(name) => <p class="flex min-w-0 flex-wrap items-center gap-2 text-interface text-ink-gray-8" data-testid="start-seed">
      <span class="lucide-corner-down-right size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{s.source() ? t("start.seed.mission") : t("start.seed.play")} <strong>{name()}</strong>. {s.intent().trim() ? t("start.seed.replaces") : t("start.seed.add")}</span>
      <Button variant="ghost" size="sm" iconLeft="lucide-x" onClick={clear}>{t("start.seed.remove")}</Button>
    </p>}</Show>
    <Show when={s.playId()}><StartTeamChoice start={s} disabled={props.disabled} /></Show>
    <fieldset class={`m-0 flex min-w-0 flex-col gap-2 border-0 p-0${props.compact ? " brain-start-compact" : ""}`} aria-label={t("start.ready.label")}>
      <Show when={s.playList().length || (s.library.state().data?.starterPlays.installable ?? 0) > 0}>
        <div class="flex min-w-0 flex-wrap items-center gap-2" data-testid="play-chips"><span class="text-caption text-ink-gray-7">{t("start.plays")}</span>
          {/* On a phone the first three Plays show and the rest sit behind one chip, so six Plays do not push the box off the screen. */}
          <For each={s.playList()}>{(play, index) => <span class={index() >= PHONE_PLAYS && s.playId() !== play.playId ? "hidden sm:contents" : "contents"}>{chip(play.title, "lucide-book-open-check", s.playId() === play.playId, () => s.pickPlay(play.playId))}</span>}</For>
          <Show when={s.playList().length > PHONE_PLAYS}><span class="contents sm:hidden">{chip(t("start.morePlays", { n: s.playList().length - PHONE_PLAYS }), "lucide-ellipsis", false, () => void navigate(`/w/${s.workspaceId()}/plays`))}</span></Show>
          <Show when={!s.playList().length}><AddStarterPlays summary={s.library.state().data} onAdded={s.reloadLibrary} variant="chip" /></Show></div>
      </Show>
      <div class="flex min-w-0 flex-wrap items-center gap-2"><span class="text-caption text-ink-gray-7">{t("start.reuse")}</span>
        {chip(t("start.previous"), "lucide-history", panel() === "previous", () => toggle("previous"), { expanded: panel() === "previous" })}
        {chip(t("start.repeat"), "lucide-repeat", panel() === "repeat", () => toggle("repeat"), { expanded: panel() === "repeat" })}
      </div>
      <Show when={props.sample}>
        <div class="flex min-w-0 flex-wrap items-center gap-2"><span class="text-caption text-ink-gray-7">{t("start.newHere")}</span>
          {chip(t("start.sample"), "lucide-sparkles", false, () => void s.startSample())}
          <span class="brain-start-hint text-caption text-ink-gray-7">{t("start.sample.hint")}</span></div>
      </Show>
    </fieldset>
    <Show when={panel() === "previous"}>
      <section class="flex min-w-0 flex-col gap-2 rounded-lg border border-outline-gray-2 p-3" aria-label="Choose a previous mission">
        <p class="text-caption text-ink-gray-7">Brain searches the missions it verified. Pick one: its goal and criteria seed the new mission, and the new brief names the source.</p>
        <TextInput label="Search verified missions" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} placeholder={s.intent().trim() ? "Searching for what you typed above" : "A few words, for example: churn report"} />
        <Show when={asked()} fallback={<p class="text-interface text-ink-gray-8" role="status">Type a few words above or here and Brain looks for earlier verified work.</p>}>
          <Show when={!found.loading} fallback={<p class="text-interface text-ink-gray-7" role="status">Searching...</p>}>
            <Show when={!found()?.failed} fallback={<p class="text-interface text-ink-red-7" role="alert">The search did not run. Try again in a moment.</p>}>
              <Show when={previous().length} fallback={<p class="text-interface text-ink-gray-8" role="status">Nothing to reuse yet for that. Missions Brain verified will appear here, with when they were last verified.</p>}>
                <ul class="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0"><For each={previous()}>{candidateRow}</For></ul>
              </Show>
            </Show>
          </Show>
        </Show>
      </section>
    </Show>
    <Show when={panel() === "repeat"}>
      <section class="flex min-w-0 flex-col gap-2 rounded-lg border border-outline-gray-2 p-3" aria-label="Choose a mission to repeat">
        <p class="text-caption text-ink-gray-7">Pick a finished mission to run again on a schedule.</p>
        <Show when={s.candidates().length >= SEARCH_FROM}><TextInput label="Search finished missions" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} /></Show>
        <Show when={s.candidates().length} fallback={<p class="text-interface text-ink-gray-8" role="status">Nothing to reuse yet. Missions you finish will appear here, with when they were last verified.</p>}>
          <Show when={repeatable().length} fallback={<p class="text-interface text-ink-gray-8" role="status">No finished mission matches that search.</p>}>
            <ul class="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0"><For each={repeatable()}>{candidateRow}</For></ul>
          </Show>
        </Show>
      </section>
    </Show>
    <details class="text-interface"><summary class="cursor-pointer text-ink-gray-8">{t("start.more")}</summary>
      <div class="mt-3 flex min-w-0 flex-col gap-3">
        <TextInput label={t("start.title")} value={s.title()} onInput={(event) => s.setTitle(event.currentTarget.value)} placeholder={s.derivedTitle() || t("start.title.placeholder")} />
        <Select label={t("start.tasks.label")} description={t("start.tasks.description")} value={s.startMode()}
          options={[{ value: "auto", label: t("start.tasks.auto") }, { value: "ask", label: t("start.tasks.ask") }]} onValueChange={(value) => s.setStartMode(value ?? "auto")} />
      </div>
    </details>
  </div>;
}
