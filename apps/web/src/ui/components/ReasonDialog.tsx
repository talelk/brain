import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput, Textarea } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";

/**
 * The one reason-required command dialog: a named, recorded reason plus
 * Cancel/themed confirm. Every operational command that needs a reason renders
 * through this instead of re-implementing the Dialog shape.
 */
export function ReasonDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  reason: string;
  onReason: (value: string) => void;
  reasonLabel?: string;
  multiline?: boolean;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "red" | "blue";
  busy?: boolean;
  onConfirm: (reason: string) => void;
}): JSX.Element {
  const confirm = () => {
    if (!props.reason.trim() || props.busy) return;
    props.onConfirm(props.reason.trim());
  };
  return <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <Dialog.Content size="md">
      <Dialog.Header><Dialog.Title>{props.title}</Dialog.Title><Dialog.Description>{props.description}</Dialog.Description></Dialog.Header>
      <div class="my-4">
        <Show when={props.multiline ?? true} fallback={<TextInput label={props.reasonLabel ?? "Reason"} value={props.reason} onInput={(event) => props.onReason(event.currentTarget.value)} required />}>
          <Textarea label={props.reasonLabel ?? "Reason"} value={props.reason} onInput={(event) => props.onReason(event.currentTarget.value)} required />
        </Show>
      </div>
      <Dialog.Footer class="justify-end">
        <Button size="md" variant="outline" disabled={props.busy} onClick={props.onClose}>{props.cancelLabel ?? "Cancel"}</Button>
        <Button size="md" variant="solid" theme={props.tone ?? "red"} loading={props.busy} disabled={!props.reason.trim()} onClick={confirm}>{props.confirmLabel}</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>;
}
