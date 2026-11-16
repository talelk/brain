import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import type { Mission, MissionEvidenceBundle, MissionJudge } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ATTENTION_CHANGED } from "../attention";
import { ActionFeedback } from "../components/ActionFeedback";
import { WorkspaceSection } from "../components/Domain";
import { CriterionCoverage } from "./CriterionCoverage";
import { DateText } from "../screen-region";
import { t, tn } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** One finding per line, as the command takes them: trimmed, none empty, at most 50 of 2000 characters. */
function findingsOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim().slice(0, 2000)).filter((line) => line.length > 0).slice(0, 50);
}

const NOT_RUN = { "hosted-off": "signoff.judge.hostedOff", budget: "signoff.judge.budget", "no-evidence": "signoff.judge.noEvidence", "too-late": "signoff.judge.tooLate" } as const;

/**
 * What the advisory judge did for this bundle (#95): one neutral line, never a badge a pass could be mistaken for. When no judge ran, or it
 * could not be reached, it says so plainly; sign-off never waits for it.
 */
function JudgeNote(props: { judge: MissionJudge }): JSX.Element {
  const ran = () => props.judge.state === "done" || props.judge.state === "running" || props.judge.state === "pending";
  const text = (): string => {
    const judge = props.judge;
    if (judge.state === "pending") return t("signoff.judge.pending");
    if (judge.state === "running") return t("signoff.judge.running");
    if (judge.state === "unavailable") return t("signoff.judge.unavailable");
    if (judge.state === "done") return t(judge.reason === "budget" ? "signoff.judge.doneBudget" : "signoff.judge.done", { model: judge.model ?? "" });
    const reason = judge.reason === "budget" || judge.reason === "no-evidence" || judge.reason === "too-late" ? judge.reason : "hosted-off";
    return t(NOT_RUN[reason]);
  };
  return <p class="m-0 flex min-w-0 items-start gap-2 text-caption text-ink-gray-7" data-testid="signoff-judge" data-judge={props.judge.state} data-reason={props.judge.reason ?? ""}>
    <span class={`${ran() ? "lucide-bot" : "lucide-circle-slash"} mt-0.5 size-4 shrink-0`} aria-hidden="true" />{text()}
  </p>;
}

/**
 * Sign-off (#92): when a mission's work is finished and its evidence bundle is submitted, a person records the mission verdict here:
 * verified (then the mission can close as achieved) or rejected with findings (the mission returns to work and the coordinator gets
 * the findings). Each success criterion is shown with the work serving it and the checks that name it, and one no check names is flagged
 * before the verdict buttons (ADR 0034). A person's verdict is an independent human check; no agent can record it. A closed mission reads as a record (who verified it, what names each criterion), never as pre-sign-off advice; one the Governor verified by itself says no person signed it off. Nothing shows for a mission that is neither
 * waiting for sign-off nor signed off.
 */
export function MissionSignOff(props: { mission: Mission; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const bundle = createScopedRead<MissionEvidenceBundle | null>({
    scope: app.scope,
    live: true,
    load: async (scope, signal) => {
      const response = await query<Envelope<MissionEvidenceBundle | null>>({ queryType: "missionBundles.latest", workspaceId: scope.workspaceId, resourceId: props.mission.missionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const current = () => bundle.state().data ?? undefined;
  const waiting = () => props.mission.state === "verifying" && current()?.state === "submitted";
  const verified = () => props.mission.state === "verifying" && current()?.state === "verified";
  const signedOff = () => props.mission.state === "closed" && props.mission.outcome === "achieved" && current()?.state === "verified";
  // Only a person's recorded verdict is independence L3; a mission Brain closed itself from its tasks' independent checks was signed off by nobody.
  const byPerson = () => current()?.independence === "L3";
  const [rejecting, setRejecting] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function act(fn: () => Promise<{ accepted: boolean; detail: string }>): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await fn();
      if (!receipt.accepted) throw new Error(receipt.detail);
      setRejecting(false);
      setClosing(false);
      setText("");
      props.onChanged();
      void bundle.refresh({ force: true });
      window.dispatchEvent(new Event(ATTENTION_CHANGED));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("signoff.refused"));
    } finally {
      setBusy(false);
    }
  }
  const verdict = (outcome: "verified" | "rejected", findings?: string[]) => act(() => app.run("mission.verdict.record", {
    missionId: props.mission.missionId, bundleDigest: current()!.digest, outcome, ...(findings ? { findings } : {}),
  }));
  const close = () => act(() => app.run("mission.close", { missionId: props.mission.missionId, outcome: "achieved" }, { expectedVersion: props.mission.version }));

  return <Show when={waiting() || verified() || signedOff()}>
    <WorkspaceSection title={t("signoff.title")} description={signedOff() ? t("signoff.description.done") : t("signoff.description")}>
      <div class="flex min-w-0 flex-col gap-3" data-testid="mission-signoff" data-state={signedOff() ? "signed-off" : verified() ? "verified" : "waiting"} data-signed-by={signedOff() ? (byPerson() ? "person" : "brain") : undefined}>
        <Show when={current()}>{(entry) => <p class="m-0 text-interface text-ink-gray-7" data-testid="signoff-facts">
          {tn("signoff.facts.tasks", entry().items.length)} · {tn("signoff.facts.outputs", entry().outputVersions.length)} · {t("signoff.facts.brief", { version: entry().briefVersion })}
        </p>}</Show>
        <Show when={current()}>{(entry) => <CriterionCoverage coverage={entry().coverage} judge={entry().judge} record={signedOff() ? (byPerson() ? "person" : "brain") : undefined} />}</Show>
        <Show when={current()}>{(entry) => <JudgeNote judge={entry().judge} />}</Show>
        <Show when={signedOff()}>
          <p class="m-0 flex items-center gap-2 text-interface text-ink-gray-9" data-testid="signoff-done"><span class="lucide-badge-check size-4 shrink-0 text-ink-green-8" aria-hidden="true" />{byPerson() ? t("signoff.done", { name: app.personName(current()?.verdictBy) }) : t("signoff.done.brain")} <span class="text-caption text-ink-gray-6"><DateText value={props.mission.updatedAt} /></span></p>
        </Show>
        <Show when={waiting() || verified()}>
          <Show when={app.canDispatch()} fallback={<p class="m-0 text-caption text-ink-gray-7" data-testid="signoff-no-scope">{t("signoff.noScope")}</p>}>
            <Show when={waiting()}>
              <p class="m-0 text-interface text-ink-gray-7">{t("signoff.intro")}</p>
              <Show when={!rejecting()} fallback={
                <div class="flex min-w-0 flex-col gap-2">
                  <Textarea label={t("signoff.findings")} value={text()} rows={4} onInput={(event) => setText(event.currentTarget.value)} />
                  <div class="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="solid" theme="red" iconLeft="lucide-undo-2" disabled={findingsOf(text()).length === 0 || busy()} loading={busy()} onClick={() => void verdict("rejected", findingsOf(text()))}>{t("signoff.sendBack")}</Button>
                    <Button size="sm" variant="ghost" disabled={busy()} onClick={() => setRejecting(false)}>{t("decision.cancel")}</Button>
                  </div>
                </div>}>
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" disabled={busy()} loading={busy()} onClick={() => void verdict("verified")}>{t("signoff.verify")}</Button>
                  <Button size="sm" variant="outline" iconLeft="lucide-message-square-warning" disabled={busy()} onClick={() => setRejecting(true)}>{t("signoff.reject")}</Button>
                </div>
              </Show>
            </Show>
            <Show when={verified()}>
              <p class="m-0 flex flex-wrap items-center gap-2 text-interface text-ink-gray-9"><Badge size="sm" theme="green" label={t("signoff.badge.verified")} />{byPerson() ? t("signoff.verified") : t("signoff.verified.brain")}</p>
              <div class="flex flex-wrap items-center gap-2">
                <Show when={!closing()} fallback={<>
                  <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" disabled={busy()} loading={busy()} onClick={() => void close()}>{t("decision.verdict.confirmed")}</Button>
                  <Button size="sm" variant="ghost" disabled={busy()} onClick={() => setClosing(false)}>{t("decision.verdict.notYet")}</Button>
                </>}>
                  <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-flag" onClick={() => setClosing(true)}>{t("signoff.close")}</Button>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
        <ActionFeedback tone="error" message={error()} />
      </div>
    </WorkspaceSection>
  </Show>;
}
