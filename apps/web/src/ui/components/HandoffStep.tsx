import { createEffect, createResource, createSignal, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { Handoff, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor, query } from "../../data/client";
import { FormSheet } from "./BrainForm";
import { t } from "../../i18n";

/**
 * Work that other tasks depend on needs a handoff before Done: the member's
 * plain notes for the next tasks. Brain derives the facts (evidence, criterion
 * status, outputs) itself; these notes stay claims. This reads whether the
 * step is still owed for one work item.
 */
export function createHandoffNeed(item: Accessor<WorkItem | undefined>): { required: Accessor<boolean>; refresh: () => Promise<void> } {
  const app = useApp();
  const [tick, setTick] = createSignal(0);
  const [need, { refetch }] = createResource(
    () => { const current = item(); return current && current.state === "review" ? { id: current.workItemId, missionId: current.missionId, version: current.version, workspaceId: app.workspaceId(), tick: tick() } : undefined; },
    async (key) => {
      const listed = await query<{ snapshot: { items: WorkItem[] } }>({ queryType: "workItems.list", workspaceId: key.workspaceId, limit: 100 });
      const dependents = listed.snapshot.items.filter((other) => other.missionId === key.missionId && other.state !== "abandoned" && other.dependsOn.includes(key.id));
      if (dependents.length === 0) return false;
      const received = await query<{ snapshot: { items: Handoff[] } }>({ queryType: "handoffs.forWorkItem", workspaceId: key.workspaceId, resourceId: dependents[0]!.workItemId });
      return !received.snapshot.items.some((handoff) => handoff.workItemId === key.id);
    },
  );
  return { required: () => need() === true, refresh: async () => { setTick((value) => value + 1); await refetch(); } };
}

/** The reviewer confirms notes pre-filled from the item's own verified evidence; nothing is invented. */
export function HandoffSheet(props: { item: WorkItem; open: boolean; onClose: () => void; onSubmitted: () => void | Promise<void> }): JSX.Element {
  const app = useApp();
  const [summary, setSummary] = createSignal("");
  const [nextAction, setNextAction] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [prefilled, setPrefilled] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    const item = props.item;
    setError(""); setPrefilled(false); setSummary(""); setNextAction("");
    void governor<{ items: { digest: string; passedCriteria: string[] }[] }>(`/v1/evidence?workspaceId=${encodeURIComponent(app.workspaceId())}&workItemId=${encodeURIComponent(item.workItemId)}`)
      .then((own) => {
        const passed = [...new Set(own.items.flatMap((bundle) => bundle.passedCriteria))].filter((criterion) => item.criteria.includes(criterion));
        if (passed.length === 0) return;
        setSummary(`Finished "${item.title}". Independently verified: ${passed.join(", ")}.`);
        setPrefilled(true);
      })
      .catch(() => { /* the person writes the notes themselves when evidence cannot be read */ });
  });

  async function submit(): Promise<void> {
    if (!summary().trim()) return;
    setBusy(true); setError("");
    try {
      const result = await app.run("handoff.submit", { workItemId: props.item.workItemId, notes: { summary: summary().trim(), ...(nextAction().trim() ? { nextAction: nextAction().trim() } : {}) } });
      if (!result.accepted) { setError(result.detail || "The handoff was refused"); return; }
      await props.onSubmitted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The handoff was refused");
    } finally { setBusy(false); }
  }

  return <FormSheet open={props.open} onClose={props.onClose} title={t("plan.hand-off-to-the-next-tasks.33d2")} centered busy={busy()}
    description={`Tasks that follow "${props.item.title}" receive these notes with the facts Brain verified. Notes are claims, never evidence.`}
    submit={t("plan.hand-off.8379")} icon="lucide-send" error={error()} errorTitle={t("plan.not-handed-off.5249")} disabled={!summary().trim()} onSubmit={submit}>
    <Show when={prefilled()}><Alert theme="blue" variant="outline" title={t("plan.pre-filled-from-this-task-s-veri.ebe1")} description={t("plan.review-and-edit-before-handing-o.9e7e")} /></Show>
    <Textarea label={t("plan.what-was-done.593a")} required value={summary()} onInput={(event) => setSummary(event.currentTarget.value)} />
    <Textarea label={t("plan.what-the-next-tasks-should-do-fi.b0b7")} value={nextAction()} onInput={(event) => setNextAction(event.currentTarget.value)} />
  </FormSheet>;
}
