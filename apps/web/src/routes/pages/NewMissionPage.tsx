import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { PlayView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { FormRow, FormSheet } from "../../ui/components/BrainForm";
import MissionsPage from "./MissionsPage";
import { missionHref } from "../../ui/mission-links";

/**
 * Start a mission (#43): from a play of the active release, or described
 * directly, in a side sheet over the missions list. A play proposes its plan
 * and team for confirmation; nothing runs until a person confirms the plan.
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
  const [title, setTitle] = createSignal("");
  const [intent, setIntent] = createSignal("");
  const [criteria, setCriteria] = createSignal("");
  const [constraints, setConstraints] = createSignal("");
  const [autonomy, setAutonomy] = createSignal("");
  const [budget, setBudget] = createSignal("");
  const [startMode, setStartMode] = createSignal("auto");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  const selected = () => (plays.state().data ?? []).find((play) => play.playId === playId());
  const [attempted, setAttempted] = createSignal(false);
  const errors = () => ({
    title: title().trim() ? undefined : "Give the mission a title.",
    intent: playId() || intent().trim() ? undefined : "Describe what the mission should achieve, or pick a play.",
    criteria: playId() || lines(criteria()).length ? undefined : "Add at least one success criterion, one per line.",
    budget: !budget().trim() || Number(budget()) > 0 ? undefined : "Enter a positive amount in µUSD, or leave it empty.",
  });
  const ready = () => !Object.values(errors()).some(Boolean);
  const shown = (key: keyof ReturnType<typeof errors>) => (attempted() ? errors()[key] : undefined);
  async function start(): Promise<void> {
    setAttempted(true);
    if (!ready() || busy()) return;
    setBusy(true); setError("");
    try {
      const receipt = await app.run("mission.create", {
        title: title().trim(),
        ...(playId() ? { playId: playId() } : {}),
        ...(intent().trim() ? { intent: intent().trim() } : {}),
        ...(lines(criteria()).length ? { successCriteria: lines(criteria()) } : {}),
        ...(lines(constraints()).length ? { constraints: lines(constraints()) } : {}),
        ...(autonomy() ? { autonomy: autonomy() as "supervised" | "standard" | "autonomous" } : {}),
        ...(budget().trim() ? { budget: { maxMicroUsd: Number(budget()), memberCap: 3 } } : {}),
        autoStart: startMode() === "auto",
      });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The mission was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, playId() ? "plan" : "brief"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The mission was not started."); } finally { setBusy(false); }
  }
  return <FormSheet open onClose={props.onClose} title="New mission" centered description="Start from a play or describe the mission. A play's plan and team wait for your confirmation."
    submit="Start mission" icon="lucide-flag" busy={busy()} disabled={!app.canDispatch()} onSubmit={start} error={error()} errorTitle="The mission was not started">
    <Select label="Play (optional)" description="A play brings its team, plan, brief, autonomy and budget." value={playId()} options={[{ value: "", label: "No play — describe it myself" }, ...(plays.state().data ?? []).map((play) => ({ value: play.playId, label: play.title }))]}
      onValueChange={(value) => setPlayId(value ?? "")} />
    <Show when={selected()}>{(play) => <p class="text-interface text-ink-gray-7">{play().description ?? ""} {play().team.length} members · {play().taskCount} tasks · autonomy {play().autonomy ?? "standard"}</p>}</Show>
    <TextInput label="Title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} required error={shown("title")} />
    <Textarea label="Intent" value={intent()} onInput={(event) => setIntent(event.currentTarget.value)} required={!playId()} error={shown("intent")} placeholder={playId() ? "As the play declares" : "What should this mission achieve?"} />
    <Textarea label="Success criteria (one per line)" value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} required={!playId()} error={shown("criteria")} />
    <Textarea label="Constraints (one per line)" value={constraints()} onInput={(event) => setConstraints(event.currentTarget.value)} />
    <FormRow>
      <Select label="Autonomy" value={autonomy()} options={[{ value: "", label: playId() ? "As the play declares" : "Standard" }, { value: "supervised", label: "Supervised" }, { value: "standard", label: "Standard" }, { value: "autonomous", label: "Autonomous" }]}
        onValueChange={(value) => setAutonomy(value ?? "")} />
      <TextInput label="Spend ceiling (µUSD, optional)" inputmode="numeric" value={budget()} onInput={(event) => setBudget(event.currentTarget.value.replace(/[^0-9]/gu, ""))} error={shown("budget")} />
    </FormRow>
    <Select label="Starting tasks" description="Automatic starts each ready task once the plan is confirmed. Otherwise you start every task yourself." value={startMode()} options={[{ value: "auto", label: "Start tasks automatically" }, { value: "ask", label: "Ask me before each task" }]}
      onValueChange={(value) => setStartMode(value ?? "auto")} />
  </FormSheet>;
}
