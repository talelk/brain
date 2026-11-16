import type { JsonValue } from "@brain/contracts";

/**
 * Repairs the two mistakes models most often make inside a JSON string: a backslash that is not a JSON escape (a path, a regular
 * expression, LaTeX: `\d`, `\(`, `\_`) and a raw control character such as a line break. A lone backslash is doubled so it reads as the
 * backslash the model meant; line breaks and tabs become their escapes. Text outside strings is untouched, and so is any valid escape,
 * so repairing text that already parses never changes its meaning.
 */
function repairJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (!inString) { out += char; if (char === "\"") inString = true; continue; }
    if (char === "\"") { out += char; inString = false; continue; }
    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && "\"\\/bfnrt".includes(next)) { out += char + next; index++; continue; }
      if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(text.slice(index + 2, index + 6))) { out += text.slice(index, index + 6); index += 5; continue; }
      out += "\\\\";
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) { out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`; continue; }
    out += char;
  }
  return out;
}

/** Whether a JSON value is an object (not a list, not null). */
export const isJsonObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } => value !== null && typeof value === "object" && !Array.isArray(value);

function parseJson(text: string): { value: JsonValue } | undefined {
  try { return { value: JSON.parse(text) as JsonValue }; } catch { return undefined; }
}

/** The JSON a model's answer holds, if any: the answer itself, in a code fence, or its one object inside a sentence; as written, else with strings repaired. */
export function decodeModelJson(text: string): { value: JsonValue; repaired: boolean } | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu)?.[1];
  const open = trimmed.indexOf("{"); const close = trimmed.lastIndexOf("}");
  for (const repaired of [false, true]) {
    const prepare = (candidate: string) => (repaired ? repairJsonStrings(candidate) : candidate);
    const whole = parseJson(prepare(fenced ?? trimmed));
    if (whole) return { value: whole.value, repaired };
    // A model sometimes wraps its one JSON object in a sentence; the object between the first "{" and the last "}" is still its answer.
    if (open >= 0 && close > open) {
      const inner = parseJson(prepare(trimmed.slice(open, close + 1)));
      if (inner && inner.value !== null && typeof inner.value === "object" && !Array.isArray(inner.value)) return { value: inner.value, repaired };
    }
  }
  return undefined;
}

/** Whether the text is, or holds, one complete JSON object: a deliverable that stopping the session cannot cut short. */
export function holdsCompleteObject(text: string): boolean {
  const decoded = decodeModelJson(text);
  return decoded !== undefined && decoded.value !== null && typeof decoded.value === "object" && !Array.isArray(decoded.value);
}

/** The JSON object a result is, when the whole answer parses as one (a code fence around it is removed); nothing for any other answer. */
export function wholeJsonObject(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  const body = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu)?.[1] ?? trimmed;
  const parsed = parseJson(body);
  return parsed && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value : undefined;
}
