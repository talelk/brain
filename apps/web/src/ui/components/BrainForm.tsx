import { Show } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Form } from "@talelk/newui-data/form";
import { Alert, Dialog } from "@talelk/newui-molecules";

/**
 * The one form frame (newui form contract): a real `<form>` so Enter submits,
 * `noValidate` so NewUI's own per-field `error` text is the validation UI, and
 * a bounded measure so inputs do not stretch across a wide page. Fields are the
 * public `FormControl` family (or atoms) carrying `label`/`error`/`required`.
 */
export function BrainForm(props: ParentProps<{
  onSubmit: () => void | Promise<void>;
  label?: string;
  /** Failure from the last submit; shown above the actions, never as a toast. */
  error?: string;
  errorTitle?: string;
  /** Fill the container (dialogs, cards) instead of the page measure. */
  bare?: boolean;
  class?: string;
}>): JSX.Element {
  return <Form form={{ handleSubmit: props.onSubmit }} aria-label={props.label} data-bare={props.bare ? "true" : undefined} class={`brain-form ${props.class ?? ""}`}>
    {props.children}
    <Show when={props.error}><Alert theme="red" variant="outline" title={props.errorTitle ?? "Not saved"} description={props.error} /></Show>
  </Form>;
}

/** The submit row: auto-width primary at `lg`, optional secondary action beside it. */
export function FormActions(props: ParentProps<{ submit: string; icon?: string; busy?: boolean; disabled?: boolean; theme?: "blue" | "red" }>): JSX.Element {
  return <div class="brain-form-actions">
    <Button type="submit" variant="solid" theme={props.theme ?? "blue"} iconLeft={props.icon} loading={props.busy} disabled={props.busy || props.disabled}>{props.submit}</Button>
    {props.children}
  </div>;
}

/**
 * Side sheet for creating or editing a record without leaving the page behind
 * it (NewUI `Dialog` with `position="end"`, the public side sheet). Title, description, a scrolling
 * field body and a footer pinned to the bottom with Cancel and the submit.
 * Every Brain create/edit form opens in one of these (or a centred dialog for
 * a single field); pages never embed form fields inline.
 */
export function FormSheet(props: ParentProps<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  onSubmit: () => void | Promise<void>;
  submit: string;
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  errorTitle?: string;
  size?: "md" | "lg" | "xl";
  theme?: "blue" | "red";
  /** Create forms are a centred dialog; editing a record opens the side sheet (NewUI `Dialog` guidance). */
  centered?: boolean;
}>): JSX.Element {
  return <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <Dialog.Content size={props.centered ? (props.size ?? "md") : (props.size ?? "lg")} position={props.centered ? "center" : "end"}>
      <Form form={{ handleSubmit: props.onSubmit }} aria-label={props.title} class="contents">
        <Dialog.Header><Dialog.Title>{props.title}</Dialog.Title><Show when={props.description}><Dialog.Description>{props.description}</Dialog.Description></Show></Dialog.Header>
        <div class="flex min-w-0 flex-col gap-4 py-3">
          {props.children}
          <Show when={props.error}><Alert theme="red" variant="outline" title={props.errorTitle ?? "Not saved"} description={props.error} /></Show>
        </div>
        <Dialog.Footer class="justify-end gap-2">
          <Button type="button" variant="outline" disabled={props.busy} onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="solid" theme={props.theme ?? "blue"} iconLeft={props.icon} loading={props.busy} disabled={props.busy || props.disabled}>{props.submit}</Button>
        </Dialog.Footer>
      </Form>
    </Dialog.Content>
  </Dialog.Root>;
}
