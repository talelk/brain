import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import { Button, KeyValue, TextInput, Textarea } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { JsonValue } from "@brain/contracts";
import { ErrorSummary } from "./PageLayout";

export interface SchemaField {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  const?: JsonValue;
  default?: JsonValue;
  format?: string;
  maxLength?: number;
  items?: SchemaField;
}
export interface InputSchema {
  properties?: Record<string, SchemaField>;
  required?: string[];
}

const label = (key: string) => key.replaceAll("-", " ").replace(/^./u, (letter) => letter.toUpperCase());
const initialText = (field: SchemaField) => field.default === undefined ? "" : typeof field.default === "string" ? field.default : JSON.stringify(field.default);

export function SchemaForm(props: {
  schema: InputSchema;
  schemaKey: string;
  submitLabel: string;
  busy: boolean;
  disabled?: boolean;
  error?: string;
  onChange?: () => void;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}): JSX.Element {
  const fields = () => Object.entries(props.schema.properties ?? {});
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [json, setJson] = createSignal("{}");
  const [errors, setErrors] = createSignal<string[]>([]);
  createEffect(on(() => props.schemaKey, () => {
    setValues(Object.fromEntries(fields().map(([key, field]) => [key, initialText(field)])));
    setJson("{}"); setErrors([]);
  }, { defer: false }));
  function update(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    props.onChange?.();
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const nextErrors: string[] = [];
    const input: Record<string, unknown> = {};
    try {
      if (!fields().length) Object.assign(input, JSON.parse(json()) as Record<string, unknown>);
      for (const [key, field] of fields()) {
        const raw = values()[key] ?? "";
        const required = props.schema.required?.includes(key) === true;
        if (required && field.const === undefined && !raw.trim()) { nextErrors.push(`${field.title ?? label(key)} is required.`); continue; }
        if (!raw.trim() && !required && field.const === undefined && field.default === undefined) continue;
        if (field.const !== undefined) input[key] = field.const;
        else if (field.type === "integer" || field.type === "number") {
          const value = Number(raw);
          if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) nextErrors.push(`${field.title ?? label(key)} must be ${field.type === "integer" ? "a whole number" : "a number"}.`);
          else input[key] = value;
        } else if (field.type === "boolean") input[key] = raw === "true";
        else if (field.type === "string") input[key] = raw;
        else {
          try { input[key] = JSON.parse(raw || (field.type === "array" ? "[]" : "{}")) as unknown; }
          catch { nextErrors.push(`${field.title ?? label(key)} must contain valid JSON.`); }
        }
      }
    } catch { nextErrors.push("Workflow input must be a valid JSON object."); }
    setErrors(nextErrors);
    if (!nextErrors.length) await props.onSubmit(input);
  }
  return <form onSubmit={(event) => void submit(event)} class="flex flex-col gap-field-gap" novalidate>
    <ErrorSummary errors={[...errors(), ...(props.error ? [props.error] : [])]} title="Dispatch needs attention" />
    <For each={fields()}>{([key, field]) => {
      const fieldLabel = field.title ?? label(key);
      const required = props.schema.required?.includes(key) === true;
      return <Show when={field.const === undefined} fallback={<KeyValue label={fieldLabel} value={String(field.const)} orientation="vertical" />}>
        <Show when={field.enum || field.type === "boolean"} fallback={
          <Show when={field.type === "string" && (field.maxLength ?? 0) <= 200 && field.format !== "textarea"} fallback={
            <TextInput id={`field-${key}`} type={field.type === "number" || field.type === "integer" ? "number" : "text"} label={fieldLabel}
              description={field.description} required={required} value={values()[key] ?? ""} disabled={props.busy}
              onInput={(event) => update(key, event.currentTarget.value)} />
          }>
            <Textarea id={`field-${key}`} label={fieldLabel} description={field.description ?? (field.type === "string" ? undefined : `Enter ${field.type === "array" ? "a JSON array" : "a JSON object"}`)}
              required={required} value={values()[key] ?? ""} disabled={props.busy} onInput={(event) => update(key, event.currentTarget.value)} />
          </Show>
        }>
          <Select label={fieldLabel} description={field.description} required={required} value={values()[key] || null} disabled={props.busy}
            options={(field.enum ?? ["true", "false"]).map((value) => ({ value, label: value }))} onValueChange={(value) => update(key, value ?? "")} />
        </Show>
      </Show>;
    }}</For>
    <Show when={!fields().length}><Textarea label="Workflow input (JSON object)" value={json()} disabled={props.busy}
      onInput={(event) => { setJson(event.currentTarget.value); props.onChange?.(); }} /></Show>
    <Button type="submit" class="min-h-11" loading={props.busy} disabled={props.disabled || props.busy}>{props.submitLabel}</Button>
  </form>;
}
