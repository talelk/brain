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
