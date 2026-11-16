import type { JsonSchema, JsonValue } from "@brain/contracts";

/** Something a tool could not do, said in words for the agent that called it. */
export class ToolRefusal extends Error {}

/**
 * Checks a call's input against the schema `inputSchema` (workspace/load.ts) makes from a tool's or a Play's `[inputs.*]`: an object with
 * typed properties, some required, nothing else allowed. Returns what is wrong, in words an agent can act on, or undefined.
 */
export function inputProblem(schema: JsonSchema, input: JsonValue): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "the input must be a JSON object";
  const properties = (schema["properties"] ?? {}) as { readonly [name: string]: { readonly type: string; readonly enum?: readonly JsonValue[]; readonly items?: { readonly type: string; readonly enum?: readonly JsonValue[] } } };
  const values = input as { readonly [name: string]: JsonValue };
  for (const name of (schema["required"] ?? []) as readonly string[]) if (values[name] === undefined) return `"${name}" is required`;
  const isA = (value: JsonValue, type: string): boolean =>
    type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type;
  for (const [name, value] of Object.entries(values)) {
    const spec = properties[name];
    if (!spec) return `"${name}" is not an input of this tool; its inputs are ${Object.keys(properties).join(", ") || "none"}`;
    if (!isA(value, spec.type)) return `"${name}" must be of type ${spec.type}`;
    if (spec.enum && !spec.enum.includes(value)) return `"${name}" must be one of ${spec.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}`;
    const items = spec.items;
    if (items && Array.isArray(value)) {
      const bad = value.find((item) => !isA(item, items.type) || (items.enum !== undefined && !items.enum.includes(item)));
      if (bad !== undefined) return `every item of "${name}" must be of type ${items.type}${items.enum ? `, one of ${items.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}` : ""}`;
    }
  }
  return undefined;
}
