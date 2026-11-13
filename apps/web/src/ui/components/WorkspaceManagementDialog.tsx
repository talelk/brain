import { createRenderEffect, createSignal, Show } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog } from "@talelk/newui-molecules";
import type { WorkspaceSummary } from "@brain/contracts";
import { governor } from "../../data/client";
import { send } from "../../data/commands";
import { useApp } from "../app-context";
import { StatusBadge } from "./StatusBadge";
import { ReasonDialog } from "./ReasonDialog";
import { BrainForm, FormActions } from "./BrainForm";
import { t } from "../../i18n";

type LifecycleAction = "suspend" | "resume" | "archive";

export function WorkspaceManagementDialog(props: {
  open: boolean;
  workspace?: WorkspaceSummary;
  onClose: () => void;
  onChanged: (workspaceId: string) => void | Promise<void>;
}) {
  const app = useApp();
  const formId = crypto.randomUUID();
  const fieldId = (name: string) => `workspace-${formId}-${name}`;
  const [workspaceId, setWorkspaceId] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [ownerId, setOwnerId] = createSignal("");
  const [tags, setTags] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [operation, setOperation] = createSignal<LifecycleAction>();
  const [attempted, setAttempted] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");

  let initializedFor = "";
  createRenderEffect(() => {
    const key = props.open ? props.workspace?.workspaceId ?? "create" : "";
    if (!key || key === initializedFor) return;
    initializedFor = key;
    const workspace = props.workspace;
    setWorkspaceId(workspace?.workspaceId ?? `ws-${crypto.randomUUID()}`);
    setDisplayName(workspace?.displayName ?? ""); setDescription(workspace?.description ?? "");
    setOwnerId(workspace?.ownerId ?? app.identity()?.actor.actorId ?? ""); setTags((workspace?.tags ?? []).join(", "));
    setReason(""); setError(""); setMessage(""); setAttempted(false);
  });

  async function save() {
    setAttempted(true);
    if (busy()) return;
    const values = {
      displayName: displayName().trim(), description: description().trim(), ownerId: ownerId().trim(),
      tags: tags().split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    if (!values.displayName || !values.ownerId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (props.workspace) {
        const receipt = await send("workspace.update", { workspaceId: props.workspace.workspaceId, ...values }, { workspaceId: props.workspace.workspaceId, expectedVersion: props.workspace.version });
        if (!receipt.accepted) throw new Error(receipt.error.detail);
      } else {
        await governor("/v1/setup/workspace", { workspaceId: workspaceId(), slug: values.displayName, ...values });
        await app.reloadIdentity();
      }
      setMessage(props.workspace ? t("adm.workspace-metadata-saved.5480") : t("adm.workspace-created-and-initial-wo.e300"));
      await props.onChanged(workspaceId());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace save failed"); }
    finally { setBusy(false); }
  }

  function begin(action: LifecycleAction) {
    setOperation(action); setReason(""); setError("");
  }

  async function control(action: LifecycleAction, reasonText: string) {
    const workspace = props.workspace;
    if (!workspace || busy()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const receipt = await send("workspace.control", { workspaceId: workspace.workspaceId, action, reason: reasonText }, { workspaceId: workspace.workspaceId, expectedVersion: workspace.version });
      if (!receipt.accepted) throw new Error(receipt.error.detail);
      setMessage(action === "suspend" ? "Workspace suspended. Existing history and running-attempt outcomes are preserved." : action === "resume" ? t("adm.workspace-resumed-after-configur.b0c3") : t("adm.workspace-archived-its-history-r.c419"));
      setReason(""); setOperation(undefined);
      await props.onChanged(workspace.workspaceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace lifecycle action failed"); }
    finally { setBusy(false); }
  }

  const operationTitle = () => operation() === "suspend" ? "Suspend workspace" : operation() === "resume" ? t("adm.validate-and-resume.9f77") : t("adm.archive-workspace.13b7");
  const operationDescription = () => operation() === "suspend"
    ? "Prevent new dispatch and effects while preserving current work and running-attempt outcomes. A reason is required."
    : operation() === "resume"
      ? "Revalidate the active release and unresolved effects before enabling new work. A reason is required."
      : "Disable operational access while retaining required audit history. Archive is allowed only after active-work checks.";

  return <>
    <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}><Dialog.Content size="lg">
      <Dialog.Header><Dialog.Title>{props.workspace ? `Manage ${props.workspace.displayName}` : "Create workspace"}</Dialog.Title><Dialog.Description>{props.workspace ? t("adm.operational-metadata-and-state-l.100b") : t("adm.create-an-operational-workspace.92d7")}</Dialog.Description></Dialog.Header>
      <div class="my-3 grid max-h-[70dvh] gap-4 overflow-y-auto pe-1 lg:grid-cols-2">
        <BrainForm bare label={t("adm.workspace-general-settings.2790")} onSubmit={save}>
          <h3 class="text-base-medium">{t("adm.general.9239")}</h3>
          <Show when={!props.workspace}><TextInput id={fieldId("id")} label={t("adm.logical-workspace-id.3954")} value={workspaceId()} readonly description={t("adm.immutable-organization-scoped-id.d4d4")} /></Show>
          <TextInput id={fieldId("name")} label={t("adm.display-name.c787")} value={displayName()} onInput={(event) => setDisplayName(event.currentTarget.value)} required error={attempted() && !displayName().trim() ? "Enter a display name." : undefined} disabled={busy()} />
          <Textarea id={fieldId("description")} label={t("adm.description.55f8")} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} disabled={busy()} />
          <TextInput id={fieldId("owner")} label={t("adm.owner-principal-id.4623")} value={ownerId()} onInput={(event) => setOwnerId(event.currentTarget.value)} description={t("adm.must-be-an-active-member-of-this.5a7d")} required error={attempted() && !ownerId().trim() ? "Enter the owner principal ID." : undefined} disabled={busy()} />
          <TextInput id={fieldId("tags")} label={t("adm.tags.848e")} value={tags()} onInput={(event) => setTags(event.currentTarget.value)} description={t("adm.comma-separated-operational-labe.c5f6")} disabled={busy()} />
          <FormActions submit={props.workspace ? t("adm.save-metadata.ac83") : t("adm.create-workspace.8e09")} busy={busy()} />
        </BrainForm>
        <section class={props.workspace ? "flex flex-col gap-4 border-t border-outline-gray-1 pt-4 lg:border-s lg:border-t-0 lg:ps-5 lg:pt-0" : "hidden"} aria-label={t("adm.workspace-lifecycle.1807")}>
          <div><h3 class="text-base-medium">{t("adm.operational-state.f131")}</h3><div class="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={props.workspace?.status ?? "unknown"} /><Badge variant="outline" theme="gray" label={`Record v${props.workspace?.version ?? 1}`} /></div><p class="mt-2 text-interface text-ink-gray-7">{t("adm.suspension-prevents-new-dispatch.0d1e")}</p></div>
          <div class="flex flex-col gap-2"><Show when={props.workspace?.status === "active"}><Button variant="outline" disabled={busy()} onClick={() => begin("suspend")}>{t("adm.suspend-workspace.9752")}</Button></Show><Show when={props.workspace?.status === "suspended"}><Button variant="outline" disabled={busy()} onClick={() => begin("resume")}>{t("adm.validate-and-resume.9f77")}</Button></Show><Show when={props.workspace?.status !== "archived"}><Button variant="outline" theme="red" disabled={busy()} onClick={() => begin("archive")}>{t("adm.archive-after-checks.4569")}</Button></Show></div>
          <Alert theme="blue" variant="outline" title={t("adm.configuration-remains-reviewed.048d")} description={t("adm.use-release-management-or-the-ag.43e7")} />
        </section>
      </div>
      <Show when={error()}><Alert theme="red" variant="outline" title={t("adm.workspace-action-failed.0de3")} description={error()} /></Show>
      <Show when={message()}><Alert theme="green" variant="outline" title={t("adm.brain-confirmed.3b48")} description={message()} /></Show>
      <Dialog.Footer class="justify-end"><Button variant="outline" onClick={props.onClose}>{t("adm.close.bbfa")}</Button></Dialog.Footer>
    </Dialog.Content></Dialog.Root>
    <ReasonDialog open={Boolean(operation())} onClose={() => { setOperation(undefined); setReason(""); }} title={operationTitle()} description={operationDescription()} reason={reason()} onReason={setReason} reasonLabel="Operations reason" confirmLabel={operationTitle()} tone={operation() === "archive" ? "red" : "blue"} onConfirm={(value) => { const action = operation(); if (action) void control(action, value); }} />
  </>;
}
