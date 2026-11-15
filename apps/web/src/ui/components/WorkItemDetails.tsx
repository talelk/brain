import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { WorkItem, WorkItemPriority } from "@brain/contracts";
import { useApp } from "../app-context";
import { FormSheet } from "./BrainForm";
import { formatInstant } from "../format";
import { dateFromDueAt, dueAtFromDate, PRIORITIES } from "../work/work-model";
import { t } from "../../i18n";

const priorityLabel = (priority: WorkItemPriority): string => t(`work.priority.${priority}` as "work.priority.urgent");

/**
 * Priority, tags and due date of one work item (#116), with the form that changes them. Priority orders what runs next inside the
 * workspace's fair share; it never changes what Done needs. An overdue item is flagged here and on its card, and nothing else happens.
 */
export function WorkItemDetails(props: { item: WorkItem; canEdit: boolean; onSaved: () => Promise<void> }): JSX.Element {
  const app = useApp();
  const [open, setOpen] = createSignal(false);
  const [priority, setPriority] = createSignal<WorkItemPriority>("normal");
  const [tags, setTags] = createSignal("");
  const [due, setDue] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const start = () => {
    setPriority(props.item.priority); setTags(props.item.tags.join(", ")); setDue(dateFromDueAt(props.item.dueAt)); setError(""); setOpen(true);
  };
  async function save(): Promise<void> {
    setBusy(true);
    try {
      const result = await app.run("workItem.details.set", {
        workItemId: props.item.workItemId, priority: priority(),
        tags: tags().split(",").map((tag) => tag.trim()).filter(Boolean), dueAt: dueAtFromDate(due()),
      }, { expectedVersion: props.item.version });
      if (result.accepted) { setOpen(false); await props.onSaved(); } else setError(result.detail ?? t("work.details-not-saved"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("work.details-not-saved"));
    } finally { setBusy(false); }
  }

  return <div class="flex flex-col gap-2 border-y border-outline-gray-1 py-3" data-testid="work-details">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h4 class="text-base-medium">{t("work.priority-tags-and-due-date")}</h4>
      <Show when={props.canEdit}><Button size="sm" variant="outline" iconLeft="lucide-pencil" onClick={start}>{t("work.edit-details")}</Button></Show>
    </div>
    <dl class="grid gap-x-6 gap-y-1 text-interface text-ink-gray-7 sm:grid-cols-[auto_1fr]">
      <dt class="text-ink-gray-6">{t("work.priority")}</dt><dd data-testid="work-details-priority">{priorityLabel(props.item.priority)}</dd>
      <dt class="text-ink-gray-6">{t("work.due-date")}</dt>
      <dd class={props.item.overdue ? "font-medium text-ink-red-8" : ""}>{props.item.dueAt
        ? (props.item.overdue ? t("work.overdue", { date: formatInstant(props.item.dueAt, { day: "numeric", month: "short", year: "numeric" }) }) : formatInstant(props.item.dueAt, { day: "numeric", month: "short", year: "numeric" }))
        : t("work.no-due-date")}</dd>
      <dt class="text-ink-gray-6">{t("work.tags")}</dt>
      <dd>{props.item.tags.length > 0 ? props.item.tags.join(", ") : t("work.no-tags")}</dd>
    </dl>
    <FormSheet open={open()} onClose={() => setOpen(false)} title={t("work.edit-details-of", { title: props.item.title })} description={t("work.details-explainer")}
      submit={t("work.save-details")} icon="lucide-save" busy={busy()} error={error()} errorTitle={t("work.details-not-saved")} onSubmit={save}>
      <Select label={t("work.priority")} value={priority()} options={PRIORITIES.map((value) => ({ value, label: priorityLabel(value) }))} onValueChange={(value) => { if (value) setPriority(value as WorkItemPriority); }} />
      <TextInput label={t("work.tags")} description={t("work.tags-hint")} value={tags()} onInput={(event) => setTags(event.currentTarget.value)} />
      <TextInput label={t("work.due-date")} description={t("work.due-hint")} type="date" value={due()} onInput={(event) => setDue(event.currentTarget.value)} />
    </FormSheet>
  </div>;
}
