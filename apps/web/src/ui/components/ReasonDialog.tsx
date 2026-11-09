import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput, Textarea } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import { BrainForm } from "./BrainForm";

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
      <Dialog.Header class="min-w-0"><Dialog.Title>{props.title}</Dialog.Title><Dialog.Description class="break-words [overflow-wrap:anywhere]">{props.description}</Dialog.Description></Dialog.Header>
      <BrainForm bare label={props.title} onSubmit={confirm}>
      <div class="my-3 min-w-0">
        <Show when={props.multiline ?? true} fallback={<TextInput label={props.reasonLabel ?? "Reason"} value={props.reason} onInput={(event) => props.onReason(event.currentTarget.value)} required />}>
          <Textarea label={props.reasonLabel ?? "Reason"} value={props.reason} onInput={(event) => props.onReason(event.currentTarget.value)} required rows={3} />
        </Show>
      </div>
      <Dialog.Footer class="flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onClose}>{props.cancelLabel ?? "Cancel"}</Button>
        <Button type="submit" size="sm" variant="solid" theme={props.tone ?? "red"} loading={props.busy} disabled={!props.reason.trim()}>{props.confirmLabel}</Button>
      </Dialog.Footer>
      </BrainForm>
    </Dialog.Content>
  </Dialog.Root>;
}
