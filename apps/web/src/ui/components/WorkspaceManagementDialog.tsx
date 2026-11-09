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
      setMessage(props.workspace ? "Workspace metadata saved." : "Workspace created and initial workspace-lead access granted.");
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
      setMessage(action === "suspend" ? "Workspace suspended. Existing history and running-attempt outcomes are preserved." : action === "resume" ? "Workspace resumed after configuration and unresolved-effect checks." : "Workspace archived. Its history remains retained.");
      setReason(""); setOperation(undefined);
      await props.onChanged(workspace.workspaceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace lifecycle action failed"); }
    finally { setBusy(false); }
  }

  const operationTitle = () => operation() === "suspend" ? "Suspend workspace" : operation() === "resume" ? "Validate and resume" : "Archive workspace";
  const operationDescription = () => operation() === "suspend"
    ? "Prevent new dispatch and effects while preserving current work and running-attempt outcomes. A reason is required."
    : operation() === "resume"
      ? "Revalidate the active release and unresolved effects before enabling new work. A reason is required."
      : "Disable operational access while retaining required audit history. Archive is allowed only after active-work checks.";

  return <>
    <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}><Dialog.Content size="lg">
      <Dialog.Header><Dialog.Title>{props.workspace ? `Manage ${props.workspace.displayName}` : "Create workspace"}</Dialog.Title><Dialog.Description>{props.workspace ? "Operational metadata and state live here. Runner groups, policies and other desired behavior still change through reviewed configuration releases." : "Create an operational workspace and grant yourself workspace-lead access. Configuration is activated separately."}</Dialog.Description></Dialog.Header>
      <div class="my-3 grid max-h-[70dvh] gap-4 overflow-y-auto pe-1 lg:grid-cols-2">
        <BrainForm bare label="Workspace general settings" onSubmit={save}>
          <h3 class="text-base-medium">General</h3>
          <Show when={!props.workspace}><TextInput id={fieldId("id")} label="Logical workspace ID" value={workspaceId()} readonly description="Immutable organization-scoped identity" /></Show>
          <TextInput id={fieldId("name")} label="Display name" value={displayName()} onInput={(event) => setDisplayName(event.currentTarget.value)} required error={attempted() && !displayName().trim() ? "Enter a display name." : undefined} disabled={busy()} />
          <Textarea id={fieldId("description")} label="Description" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} disabled={busy()} />
          <TextInput id={fieldId("owner")} label="Owner principal ID" value={ownerId()} onInput={(event) => setOwnerId(event.currentTarget.value)} description="Must be an active member of this organization" required error={attempted() && !ownerId().trim() ? "Enter the owner principal ID." : undefined} disabled={busy()} />
          <TextInput id={fieldId("tags")} label="Tags" value={tags()} onInput={(event) => setTags(event.currentTarget.value)} description="Comma-separated operational labels" disabled={busy()} />
          <FormActions submit={props.workspace ? "Save metadata" : "Create workspace"} busy={busy()} />
        </BrainForm>
        <section class={props.workspace ? "flex flex-col gap-4 border-t border-outline-gray-1 pt-4 lg:border-s lg:border-t-0 lg:ps-5 lg:pt-0" : "hidden"} aria-label="Workspace lifecycle">
          <div><h3 class="text-base-medium">Operational state</h3><div class="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={props.workspace?.status ?? "unknown"} /><Badge variant="outline" theme="gray" label={`Record v${props.workspace?.version ?? 1}`} /></div><p class="mt-2 text-interface text-ink-gray-7">Suspension prevents new dispatch without cancelling active attempts. Archive additionally requires no active, blocked or unresolved work.</p></div>
          <div class="flex flex-col gap-2"><Show when={props.workspace?.status === "active"}><Button size="md" variant="outline" disabled={busy()} onClick={() => begin("suspend")}>Suspend workspace</Button></Show><Show when={props.workspace?.status === "suspended"}><Button size="md" variant="outline" disabled={busy()} onClick={() => begin("resume")}>Validate and resume</Button></Show><Show when={props.workspace?.status !== "archived"}><Button size="md" variant="outline" theme="red" disabled={busy()} onClick={() => begin("archive")}>Archive after checks</Button></Show></div>
          <Alert theme="blue" variant="outline" title="Configuration remains reviewed" description="Use Release management or the Agent/Workflow Studio for desired behavior. Access is managed under Workspace access. No active immutable release is edited here." />
        </section>
      </div>
      <Show when={error()}><Alert theme="red" variant="outline" title="Workspace action failed" description={error()} /></Show>
      <Show when={message()}><Alert theme="green" variant="outline" title="Governor confirmed" description={message()} /></Show>
      <Dialog.Footer class="justify-end"><Button size="md" variant="outline" onClick={props.onClose}>Close</Button></Dialog.Footer>
    </Dialog.Content></Dialog.Root>
    <ReasonDialog open={Boolean(operation())} onClose={() => { setOperation(undefined); setReason(""); }} title={operationTitle()} description={operationDescription()} reason={reason()} onReason={setReason} reasonLabel="Operations reason" confirmLabel={operationTitle()} tone={operation() === "archive" ? "red" : "blue"} onConfirm={(value) => { const action = operation(); if (action) void control(action, value); }} />
  </>;
}
