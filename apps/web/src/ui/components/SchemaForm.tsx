import { Show, createEffect, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { ConfigForm } from "@talelk/newui-organisms";
import { createAppForm } from "@talelk/newui-data/form";
import type { JsonValue } from "@brain/contracts";
import { ErrorSummary } from "./PageLayout";
import { Textarea } from "@talelk/newui-atoms";
import { titleize } from "../format";

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

const label = (key: string) => titleize(key);
const initialText = (field: SchemaField) => field.default === undefined ? "" : typeof field.default === "string" ? field.default : JSON.stringify(field.default);

type Values = Record<string, string>;
type Issue = { message: string; path: readonly string[] };

/** The Standard Schema over the workflow's JSON schema: required, numeric and JSON checks per field. */
function validator(schema: InputSchema, fields: readonly [string, SchemaField][]) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "brain",
      validate: (value: unknown): { value: Values } | { issues: Issue[] } => {
        const values = value as Values;
        const issues: Issue[] = [];
        for (const [key, field] of fields) {
          if (field.const !== undefined) continue;
          const raw = values[key] ?? "";
          const name = field.title ?? label(key);
          if (schema.required?.includes(key) && !raw.trim()) { issues.push({ message: `${name} is required.`, path: [key] }); continue; }
          if (!raw.trim()) continue;
          if (field.type === "integer" || field.type === "number") {
            const number = Number(raw);
            if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) issues.push({ message: `${name} must be ${field.type === "integer" ? "a whole number" : "a number"}.`, path: [key] });
          } else if (field.type === "array" || field.type === "object") {
            try { JSON.parse(raw); } catch { issues.push({ message: `${name} must contain valid JSON.`, path: [key] }); }
          }
        }
        return issues.length ? { issues } : { value: values };
      },
    },
  };
}

/** The workflow input form: NewUI's `ConfigForm` over a field map derived from the workflow's JSON schema. */
export function SchemaForm(props: {
  schema: InputSchema;
  schemaKey: string;
  submitLabel: string;
  initialInput?: JsonValue;
  busy: boolean;
  disabled?: boolean;
  error?: string;
  onChange?: () => void;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}): JSX.Element {
  const fields = () => Object.entries(props.schema.properties ?? {});
  const initialValues = (): Values => {
    const initial: Readonly<Record<string, JsonValue>> = props.initialInput && typeof props.initialInput === "object" && !Array.isArray(props.initialInput) ? props.initialInput as Readonly<Record<string, JsonValue>> : {};
    return Object.fromEntries(fields().map(([key, field]) => [key, field.const !== undefined ? String(field.const) : initial[key] === undefined ? initialText(field) : typeof initial[key] === "string" ? initial[key] as string : JSON.stringify(initial[key])]));
  };
  const fieldMap = () => Object.fromEntries(fields().map(([key, field]) => {
    const fieldLabel = field.title ?? label(key);
    const required = props.schema.required?.includes(key) === true;
    if (field.const !== undefined) return [key, { component: () => <KeyValue label={fieldLabel} value={String(field.const)} orientation="vertical" /> }];
    if (field.enum || field.type === "boolean") return [key, { type: "select", label: fieldLabel, description: field.description, required, options: (field.enum ?? ["true", "false"]).map((value) => ({ value, label: value })) }];
    if (field.type === "number" || field.type === "integer") return [key, { type: "number", label: fieldLabel, description: field.description, required }];
    if (field.type !== "string" || (field.maxLength ?? 1000) > 200 || field.format === "textarea") {
      return [key, { type: "textarea", label: fieldLabel, description: field.description ?? (field.type === "string" ? undefined : `Enter ${field.type === "array" ? "a JSON array" : "a JSON object"}`), required }];
    }
    return [key, { type: "text", label: fieldLabel, description: field.description, required }];
  }));
  const convert = (values: Values): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const [key, field] of fields()) {
      const raw = values[key] ?? "";
      const required = props.schema.required?.includes(key) === true;
      if (field.const !== undefined) { input[key] = field.const; continue; }
      if (!raw.trim() && !required && field.default === undefined) continue;
      if (field.type === "integer" || field.type === "number") input[key] = Number(raw);
      else if (field.type === "boolean") input[key] = raw === "true";
      else if (field.type === "string") input[key] = raw;
      else input[key] = JSON.parse(raw || (field.type === "array" ? "[]" : "{}")) as unknown;
    }
    return input;
  };
  const app = createAppForm<Values>({
    defaultValues: initialValues(),
    schema: validator(props.schema, fields()) as never,
    ui: fieldMap() as never,
    onSubmit: async (values) => { await props.onSubmit(convert(values)); },
  });
  // A different workflow replaces the whole field map and its values.
  createEffect(on(() => props.schemaKey, () => app.form.reset(initialValues()), { defer: true }));
  const current = app.form.useSelector((state) => state.values);
  createEffect(on(current, () => props.onChange?.(), { defer: true }));
  return <>
    <ErrorSummary errors={props.error ? [props.error] : []} title="Dispatch needs attention" />
    <Show when={fields().length} fallback={<RawJsonForm initial={props.initialInput} busy={props.busy} disabled={props.disabled} submitLabel={props.submitLabel} onChange={props.onChange} onSubmit={props.onSubmit} />}>
      <ConfigForm form={app.form as never} fields={app.ui as never}>
        <Button class="self-start max-sm:w-full" type="submit" variant="solid" theme="blue" loading={props.busy || app.submitting()} disabled={props.disabled || props.busy}>{props.submitLabel}</Button>
      </ConfigForm>
    </Show>
  </>;
}

/** A workflow with no declared properties takes one JSON object. */
function RawJsonForm(props: { initial?: JsonValue; busy: boolean; disabled?: boolean; submitLabel: string; onChange?: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void> }): JSX.Element {
  const [json, setJson] = createSignal(JSON.stringify(props.initial ?? {}));
  const [error, setError] = createSignal("");
  return <form class="flex flex-col gap-field-gap" noValidate onSubmit={(event) => {
    event.preventDefault();
    try { setError(""); void props.onSubmit(JSON.parse(json()) as Record<string, unknown>); } catch { setError("Workflow input must be a valid JSON object."); }
  }}>
    <Textarea label="Workflow input (JSON object)" value={json()} disabled={props.busy} error={error() || undefined} onInput={(event) => { setJson(event.currentTarget.value); props.onChange?.(); }} />
    <Button class="self-start max-sm:w-full" type="submit" variant="solid" theme="blue" loading={props.busy} disabled={props.disabled || props.busy}>{props.submitLabel}</Button>
  </form>;
}
