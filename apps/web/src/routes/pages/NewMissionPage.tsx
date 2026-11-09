import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { PlayView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { FormSheet } from "../../ui/components/BrainForm";
import MissionsPage from "./MissionsPage";
import { missionHref } from "../../ui/mission-links";

/**
 * Start a mission (#43): two plain choices in a dialog over the missions list.
 * "Start from a play" picks a ready-made team and plan; "Describe what you
 * want" takes one sentence. Goal, criteria, budget and autonomy are refined in
 * the plan, and nothing runs until a person confirms it.
 */
export default function NewMissionPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  return <>
    <MissionsPage />
    <NewMissionSheet onClose={() => void navigate(`/w/${app.workspaceId()}/missions`)} />
  </>;
}

function NewMissionSheet(props: { onClose: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const plays = createScopedRead<PlayView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: PlayView[] }; asOf: string; sourceWatermark: number }>({ queryType: "plays.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const [playId, setPlayId] = createSignal(typeof search.play === "string" ? search.play : "");
  const [pickedMode, setMode] = createSignal<"play" | "describe" | "">(typeof search.play === "string" ? "play" : "");
  const [title, setTitle] = createSignal("");
  const [intent, setIntent] = createSignal("");
  const [startMode, setStartMode] = createSignal("auto");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [attempted, setAttempted] = createSignal(false);
  const playList = () => plays.state().data ?? [];
  /** Plays are the best path, so they lead whenever the release has any. */
  const mode = (): "play" | "describe" => pickedMode() || (playList().length ? "play" : "describe");
  const selected = () => (mode() === "play" ? playList().find((play) => play.playId === playId()) : undefined);
  const firstLine = () => intent().trim().split("\n")[0] ?? "";
  /** The title a person did not type: the play's own, or the first words of the sentence. */
  const derivedTitle = () => {
    if (mode() === "play") return selected()?.title ?? "";
    const sentence = firstLine().replace(/[.!?]+$/u, "");
    return sentence.length <= 60 ? sentence : `${sentence.slice(0, 60).replace(/\s+\S*$/u, "")}…`;
  };
  const errors = () => ({
    play: mode() === "play" && !playId() ? "Pick the play to start from." : undefined,
    intent: mode() === "describe" && !intent().trim() ? "Say in a sentence what you want done." : undefined,
  });
  const ready = () => !Object.values(errors()).some(Boolean);
  const shown = (key: keyof ReturnType<typeof errors>) => (attempted() ? errors()[key] : undefined);
  async function start(): Promise<void> {
    setAttempted(true);
    if (!ready() || busy()) return;
    setBusy(true); setError("");
    const usePlay = mode() === "play";
    try {
      // The Governor needs at least one criterion; the sentence itself is the first, editable in the plan.
      const receipt = await app.run("mission.create", {
        title: title().trim() || derivedTitle() || "New mission",
        autoStart: startMode() === "auto",
        ...(usePlay ? { playId: playId() } : { intent: intent().trim(), successCriteria: [`Done: ${firstLine()}`] }),
      });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The mission was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, usePlay ? "plan" : "brief"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The mission was not started."); } finally { setBusy(false); }
  }
  const choice = (value: "play" | "describe", icon: string, label: string, hint: string) =>
    <Button variant={mode() === value ? "subtle" : "outline"} theme={mode() === value ? "blue" : "gray"} iconLeft={icon} aria-pressed={mode() === value}
      class="h-auto flex-1 justify-start whitespace-normal py-2 text-left" onClick={() => setMode(value)}>
      <span class="flex flex-col items-start"><span class="text-base-medium">{label}</span><span class="text-caption font-normal text-ink-gray-7">{hint}</span></span>
    </Button>;
  return <FormSheet open onClose={props.onClose} title="New mission" centered description="Nothing runs until you confirm the plan."
    submit="Start mission" icon="lucide-flag" busy={busy()} disabled={!app.canDispatch()} onSubmit={start} error={error()} errorTitle="The mission was not started">
    <div class="flex flex-col gap-2 sm:flex-row" role="group" aria-label="How to start">
      {choice("play", "lucide-book-open-check", "Start from a play", "A ready-made team and plan")}
      {choice("describe", "lucide-pencil-line", "Describe what you want", "One sentence is enough")}
    </div>
    <Show when={mode() === "play"} fallback={
      <Textarea label="What do you want done?" value={intent()} onInput={(event) => setIntent(event.currentTarget.value)} required error={shown("intent")} placeholder="For example: triage this week's support tickets and draft replies" />}>
      <Select label="Play" description="The play brings its team, plan, autonomy and budget." value={playId()} options={playList().map((play) => ({ value: play.playId, label: play.title }))}
        onValueChange={(value) => setPlayId(value ?? "")} error={shown("play")} />
      <Show when={selected()}>{(play) => <p class="text-interface text-ink-gray-7">{play().description ?? ""} {play().team.length} members · {play().taskCount} tasks</p>}</Show>
    </Show>
    <TextInput label="Title (optional)" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder={derivedTitle() || "Named for you from the play or your sentence"} />
    <Select label="Starting tasks" description="Automatic starts each ready task once the plan is confirmed. Otherwise you start every task yourself." value={startMode()}
      options={[{ value: "auto", label: "Start tasks automatically" }, { value: "ask", label: "Ask me before each task" }]} onValueChange={(value) => setStartMode(value ?? "auto")} />
    <p class="text-caption text-ink-gray-7">You can refine the goal, criteria, budget and autonomy in the plan before anything runs.</p>
  </FormSheet>;
}
