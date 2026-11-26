import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { JsonSchema } from "./files";
import type { JsonValue } from "./protocol";

/**
 * The one check of a value against a JSON Schema: a tool call's input, a tool's result and a step's answer. It is a subpath of its own
 * (`@brain/contracts/validate`), so the web app does not carry it.
 */
// A schema another system wrote may name a format Ajv does not know, or an older dialect: both are read as 2020-12 reads them.
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const known = new Map<string, ValidateFunction>();
const MOST_KEPT = 500;

function compiled(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let check = known.get(key);
  if (!check) {
    const { $schema: _dialect, $id: _id, ...own } = schema;
    check = ajv.compile(own);
    // The compiled function is kept here, bounded; the validator itself keeps nothing.
    ajv.removeSchema(own);
    if (known.size >= MOST_KEPT) known.delete(known.keys().next().value as string);
    known.set(key, check);
  }
  return check;
}

/** What the person or agent is told: the field by its name, and what it must be. */
function inWords(error: ErrorObject, schema: JsonSchema, what: "input" | "output"): string {
  const path = error.instancePath.split("/").slice(1);
  const [name, ...rest] = path;
  const of = (field: string): string => (name === undefined ? `"${field}"` : `"${[...path, field].join(".")}"`);
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") return `${of(String(params["missingProperty"]))} is required`;
  if (error.keyword === "additionalProperties") {
    const names = Object.keys((schema["properties"] ?? {}) as object).join(", ") || "none";
    return `${of(String(params["additionalProperty"]))} is not an ${what} of this tool; its ${what}s are ${names}`;
  }
  if (name === undefined) return `the ${what} must be a JSON object`;
  const field = rest.length === 1 && /^\d+$/u.test(rest[0] as string) ? `every item of "${name}"` : `"${path.join(".")}"`;
  if (error.keyword === "type") return `${field} must be of type ${String(params["type"])}`;
  if (error.keyword === "enum") return `${field} must be one of ${(params["allowedValues"] as unknown[]).map((allowed) => JSON.stringify(allowed)).join(", ")}`;
  return `${field} ${error.message ?? "is not valid"}`;
}

/** Why a schema cannot be used to check anything, or undefined when it can. */
export function schemaUnreadable(schema: JsonSchema): string | undefined {
  try {
    compiled(schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What is wrong with a value, in words, or undefined when it fits. A schema that cannot be read refuses every value. */
export function schemaProblem(schema: JsonSchema, value: JsonValue, what: "input" | "output" = "input"): string | undefined {
  let check: ValidateFunction;
  try {
    check = compiled(schema);
  } catch (error) {
    return `the ${what} schema cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (check(value)) return undefined;
  const first = check.errors?.[0];
  return first ? inWords(first, schema, what) : `the ${what} does not fit its schema`;
}
