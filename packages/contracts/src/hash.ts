import { createHash, createHmac } from "node:crypto";
import canonicalize from "canonicalize";
import type { Digest, JsonValue } from "./brain.generated";

const MAX_DEPTH = 32;
const MAX_STRING_BYTES = 1024 * 1024;

export function assertBoundedJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > MAX_DEPTH) throw new Error("JSON_TOO_DEEP");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON_NONFINITE_NUMBER");
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) throw new Error("JSON_STRING_TOO_LARGE");
    // Reject lone surrogates (RFC 8785 requires well-formed Unicode).
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = value.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) throw new Error("JSON_LONE_SURROGATE");
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        throw new Error("JSON_LONE_SURROGATE");
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedJson(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new Error("JSON_UNSUPPORTED_OBJECT_TYPE");
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) { assertBoundedJson(key); assertBoundedJson(v, depth + 1); }
    return;
  }
  throw new Error("JSON_UNSUPPORTED_TYPE");
}

/** Strict JSON parse: rejects duplicate keys, lone surrogates and non-finite numbers. */
export function parseStrictJson(text: string): JsonValue {
  let i = 0;
  let nodes = 0;
  const fail = (m: string): never => { throw new Error(m); };
  const skipWs = () => { while (i < text.length && " \t\n\r".includes(text[i] ?? "")) i++; };
  const parseString = (): string => {
    if (text[i] !== '"') fail("JSON_EXPECTED_STRING");
    i++;
    let out = "";
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === '"') { i++; return out; }
      if (ch === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("JSON_BAD_UNICODE");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          const mapped = map[e ?? ""];
          if (mapped === undefined) fail("JSON_BAD_ESCAPE");
          out += mapped;
          i += 2;
        }
      } else { if (ch.charCodeAt(0) < 32) fail("JSON_CONTROL_CHARACTER"); out += ch; i++; }
    }
    return fail("JSON_UNTERMINATED_STRING");
  };
  const parseValue = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail("JSON_TOO_DEEP");
    if (++nodes > 10_000) fail("JSON_TOO_COMPLEX");
    skipWs();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const obj: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      const seen = new Set<string>();
      skipWs();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        skipWs();
        const key = parseString();
        if (seen.has(key)) fail("JSON_DUPLICATE_KEY");
        seen.add(key);
        skipWs();
        if (text[i] !== ":") fail("JSON_EXPECTED_COLON");
        i++;
        obj[key] = parseValue(depth + 1);
        skipWs();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return obj; }
        fail("JSON_EXPECTED_COMMA_OR_END");
      }
    }
    if (ch === "[") {
      i++;
      const arr: JsonValue[] = [];
      skipWs();
      if (text[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("JSON_EXPECTED_COMMA_OR_END");
      }
    }
    if (ch === '"') return parseString();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    // eslint-disable-next-line security/detect-unsafe-regex -- Anchored JSON number grammar, not an open-ended repetition.
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      const n = Number(m[0]);
      if (!Number.isFinite(n)) fail("JSON_NONFINITE_NUMBER");
      return n;
    }
    return fail("JSON_UNEXPECTED_TOKEN");
  };
  const value = parseValue(0);
  skipWs();
  if (i !== text.length) fail("JSON_TRAILING_CONTENT");
  assertBoundedJson(value);
  return value;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  assertBoundedJson(value);
  const text = canonicalize(value as never);
  if (typeof text !== "string") throw new Error("JSON_CANONICALIZE_FAILED");
  return new TextEncoder().encode(text);
}

export function sha256Digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function domainDigest(domain: string, value: JsonValue): Digest {
  const prefix = new TextEncoder().encode(`${domain}\n`);
  const body = canonicalJsonBytes(value);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix, 0);
  all.set(body, prefix.length);
  return sha256Digest(all);
}

export function approvalSubjectDigest(subject: JsonValue): Digest {
  return domainDigest("brain:approval:v1", subject);
}

export function hmacSha256Hex(key: Uint8Array, data: Uint8Array): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
