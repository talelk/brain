import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { PlayView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { missionHref } from "../../ui/mission-links";

/**
 * Start a mission (#43): from a play of the active release, or described
 * directly. A play proposes its plan and team for confirmation; nothing runs
 * until a person confirms the plan.
 */
export default function NewMissionPage(): JSX.Element {
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
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  const selected = () => (plays.state().data ?? []).find((play) => play.playId === playId());
  const ready = () => Boolean(title().trim() && (playId() || (intent().trim() && lines(criteria()).length)));
  async function start(): Promise<void> {
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
      });
      if (!receipt.accepted || !receipt.resourceId) throw new Error(receipt.detail ?? "The mission was not started.");
      void navigate(missionHref(app.workspaceId(), receipt.resourceId, playId() ? "plan" : "brief"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The mission was not started."); } finally { setBusy(false); }
  }
  return <BrainPage title="New mission" description="Start from a play or describe the mission. A play's plan and team wait for your confirmation."
    breadcrumbs={[{ label: "Missions", href: `/w/${app.workspaceId()}/missions` }, { label: "New mission" }]}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="The mission was not started" description={error()} /></Show>
      <WorkspaceSection title="Play" description="Optional. A play brings its team, plan, brief, autonomy and budget.">
        <Select label="Play" value={playId() || null} options={[{ value: "", label: "No play — describe it myself" }, ...(plays.state().data ?? []).map((play) => ({ value: play.playId, label: play.title }))]}
          onValueChange={(value) => setPlayId(value ?? "")} />
        <Show when={selected()}>{(play) => <p class="mt-2 text-interface text-ink-gray-7">{play().description ?? ""} {play().team.length} members · {play().taskCount} tasks · autonomy {play().autonomy ?? "standard"}</p>}</Show>
      </WorkspaceSection>
      <WorkspaceSection title="Mission" description="The title and, without a play, the intent and success criteria.">
        <div class="brain-field-grid">
          <TextInput label="Title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} required />
          <Select label="Autonomy" value={autonomy() || null} options={[{ value: "", label: playId() ? "As the play declares" : "Standard" }, { value: "supervised", label: "Supervised" }, { value: "standard", label: "Standard" }, { value: "autonomous", label: "Autonomous" }]}
            onValueChange={(value) => setAutonomy(value ?? "")} />
        </div>
        <Textarea label="Intent" value={intent()} onInput={(event) => setIntent(event.currentTarget.value)} placeholder={playId() ? "As the play declares" : "What should this mission achieve?"} />
        <div class="brain-field-grid">
          <Textarea label="Success criteria (one per line)" value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} />
          <Textarea label="Constraints (one per line)" value={constraints()} onInput={(event) => setConstraints(event.currentTarget.value)} />
        </div>
        <TextInput label="Spend ceiling (µUSD, optional)" value={budget()} onInput={(event) => setBudget(event.currentTarget.value.replace(/[^0-9]/gu, ""))} />
        <Button size="md" theme="blue" class="mt-3" iconLeft="lucide-flag" loading={busy()} disabled={!ready() || busy() || !app.canDispatch()} onClick={() => void start()}>Start mission</Button>
      </WorkspaceSection>
    </PageStack>
  </BrainPage>;
}
