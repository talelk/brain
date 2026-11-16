import { For, Show, type Accessor, type JSX } from "solid-js";
import { Button, Checkbox, TextInput } from "@talelk/newui-atoms";
import { t } from "../i18n";

/** The form controls the workspace forms share, on top of the design system's inputs. */

/** Several short values typed on one line, separated by commas. */
export function ListField(props: { label: string; description?: string; value: readonly string[]; onChange: (value: string[]) => void; placeholder?: string; disabled?: boolean }): JSX.Element {
  return <TextInput size="md" label={props.label} description={props.description} placeholder={props.placeholder} disabled={props.disabled} value={props.value.join(", ")}
    onChange={(event) => props.onChange(event.currentTarget.value.split(",").map((part) => part.trim()).filter((part) => part !== ""))} />;
}

export function NumberField(props: { label: string; description?: string; value: number | undefined; onChange: (value: number | undefined) => void; min?: number; max?: number; step?: number; disabled?: boolean }): JSX.Element {
  return <TextInput size="md" type="number" label={props.label} description={props.description} min={props.min} max={props.max} step={props.step ?? "any"} disabled={props.disabled} value={props.value === undefined ? "" : String(props.value)}
    onInput={(event) => props.onChange(event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value))} />;
}

/** One of a few named choices, each with a line saying what it means. */
export function Choice<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string; help?: string }[]; onChange: (value: T) => void; disabled?: boolean }): JSX.Element {
  return (
    <fieldset class="min-w-0" disabled={props.disabled}>
      <legend class="mb-1.5 t-small font-medium text-ink-2">{props.label}</legend>
      <div class="flex flex-wrap gap-2">
        <For each={props.options}>
          {(option) => (
            <label class="flex min-w-36 flex-1 cursor-pointer flex-col rounded-xl border border-rule-2 bg-sheet px-3.5 py-2.5 has-checked:border-violet has-checked:bg-lilac has-focus-visible:focus-ring">
              <span class="flex items-center gap-2 t-text font-medium text-ink">
                <input type="radio" class="size-4 border-rule-2 text-(--violet) accent-(--violet)" name={props.label} checked={props.value === option.value} onChange={() => props.onChange(option.value)} />
                {option.label}
              </span>
              <Show when={option.help}><span class="mt-0.5 t-small text-ink-2">{option.help}</span></Show>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}

/** Any number of names picked from a known set. */
export function PickMany(props: { label: string; description?: string; options: readonly { value: string; label: string; help?: string }[]; value: readonly string[]; onChange: (value: string[]) => void; disabled?: boolean }): JSX.Element {
  const toggle = (name: string, on: boolean): void => props.onChange(on ? [...props.value, name] : props.value.filter((other) => other !== name));
  return (
    <fieldset class="min-w-0" disabled={props.disabled}>
      <legend class="mb-1.5 t-small font-medium text-ink-2">{props.label}</legend>
      <Show when={props.description}><p class="mb-2 t-small text-ink-3">{props.description}</p></Show>
      <div class="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <For each={props.options}>{(option) => <Checkbox size="md" label={<span class="t-code code-ltr">{option.label}</span>} description={option.help} checked={props.value.includes(option.value)} onCheckedChange={(on) => toggle(option.value, on)} disabled={props.disabled} />}</For>
      </div>
      <Show when={props.options.length === 0}><p class="t-small text-ink-3">{t("fields.none")}</p></Show>
    </fieldset>
  );
}

/** A list of rows a person adds to and removes from: models, projects, inputs, standing approvals. */
export function Rows<T>(props: { label: string; items: readonly T[]; onChange: (items: T[]) => void; blank: () => T; add: string; disabled?: boolean; children: (item: Accessor<T>, change: (next: T) => void, index: number) => JSX.Element }): JSX.Element {
  const change = (index: number, next: T): void => props.onChange(props.items.map((item, at) => (at === index ? next : item)));
  return (
    <fieldset class="min-w-0" disabled={props.disabled}>
      <legend class="mb-2 t-small font-medium text-ink-2">{props.label}</legend>
      <ul class="flex flex-col gap-3">
        {/* Rows are kept by position, so typing in one never rebuilds it. */}
        <For each={props.items.map((_, index) => index)}>
          {(index) => (
            <li class="flex items-start gap-2 rounded-xl border border-rule bg-paper p-3.5">
              <div class="min-w-0 flex-1">{props.children(() => props.items[index] as T, (next) => change(index, next), index)}</div>
              <Show when={!props.disabled}><Button variant="ghost" size="sm" icon="lucide-trash-2" aria-label={t("action.remove")} onClick={() => props.onChange(props.items.filter((_, at) => at !== index))} /></Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={!props.disabled}><Button variant="ghost" size="md" class="mt-2" iconLeft="lucide-plus" onClick={() => props.onChange([...props.items, props.blank()])}>{props.add}</Button></Show>
    </fieldset>
  );
}
