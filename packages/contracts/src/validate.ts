import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

const schemaPath = fileURLToPath(new URL("./brain.schema.json", import.meta.url));
const rootSchema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats(ajv);
ajv.addSchema(rootSchema, "brain");

const cache = new Map<string, ValidateFunction>();

export function validatorFor(defName: string): ValidateFunction {
  const hit = cache.get(defName);
  if (hit) return hit;
  const fn = ajv.compile({ $ref: `brain#/$defs/${defName}` });
  cache.set(defName, fn);
  return fn;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validate(defName: string, value: unknown): ValidationResult {
  const fn = validatorFor(defName);
  const ok = fn(value) as boolean;
  if (ok) return { ok: true, errors: [] };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
  return { ok: false, errors };
}

export function knownDefinitions(): readonly string[] {
  const defs = (rootSchema["$defs"] ?? {}) as Record<string, unknown>;
  return Object.keys(defs).sort();
}

/** Compile a confined release-owned payload schema without remote resolution. */
export function payloadValidator(schema: object): (value: unknown) => ValidationResult {
  const compiler = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
  addFormats(compiler);
  const fn = compiler.compile(schema);
  return (value) => ({ ok: !!fn(value), errors: (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`) });
}

/**
 * The reason a tool input schema cannot be compiled the way a runner compiles it for an agent's calls (strict mode, no formats), or
 * undefined when it can. An external server's schema usually carries keywords strict mode rejects; that must fail at registration, not at every call.
 */
export function strictSchemaProblem(schema: object): string | undefined {
  try { new Ajv2020({ allErrors: true, strict: true }).compile(schema); return undefined; } catch (error) { return error instanceof Error ? error.message.slice(0, 200) : "the schema does not compile"; }
}
