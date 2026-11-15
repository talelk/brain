/**
 * Why an attempt failed, kept short and safe to show to a person. The runner reports the failed step's own error text; the Governor is the one
 * place that redacts it, cuts it, stores it and gives it a code (a code, never a sentence: the interface words it in the reader's language).
 */
export const FAILURE_REASON_LIMIT = 500;

export const FAILURE_CODES = ["sandbox-image-missing", "sandbox-unavailable", "quota", "model-unreachable", "timeout", "other"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// Credential shapes, in the same families the knowledge store refuses to keep (memory.ts SECRET_PATTERNS), but as segments to replace.
const SECRET_SEGMENTS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bghp_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
  /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
];
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_-]{0,40}(?:api[_-]?key|client[_-]?secret|shared[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|secret|credential|private[_-]?key|key))(\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/giu;

/** The text with every credential-shaped segment replaced. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_SEGMENTS) out = out.replace(pattern, (_all, scheme: unknown) => (typeof scheme === "string" && scheme.startsWith("http") ? `${scheme}[hidden]@` : "[hidden]"));
  return out.replace(SECRET_ASSIGNMENT, (_all, name: string, sep: string) => `${name}${sep}[hidden]`);
}

/** A failed step's error as stored and shown: redacted, one line, at most FAILURE_REASON_LIMIT characters. */
export function failureReasonOf(output: unknown): string | undefined {
  const raw = typeof output === "string" ? output : output && typeof output === "object" ? (output as { error?: unknown }).error : undefined;
  if (typeof raw !== "string") return undefined;
  const clean = redactSecrets(raw).replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  return clean.length > FAILURE_REASON_LIMIT ? `${clean.slice(0, FAILURE_REASON_LIMIT - 1)}…` : clean;
}

/** What kind of failure a reason describes, from its words; the interface chooses the sentence and the one next step for each. */
export function failureCode(reason: string | null | undefined): FailureCode {
  const text = reason ?? "";
  if (/unable to find image|pull access denied|image .* not (?:found|installed|preinstalled)|no such image|brain-sandbox-\w+/iu.test(text)) return "sandbox-image-missing";
  if (/sandbox (?:create|exec|stop) failed|docker|launcher|sandboxed execution failed/iu.test(text)) return "sandbox-unavailable";
  if (/quota or rate limit|insufficient[_ ]quota|\b429\b.*(?:rate|quota|too many)|resource[_ ]exhausted/iu.test(text)) return "quota";
  if (/model is unreachable|unavailable or its model|model endpoint|ECONNREFUSED|ENOTFOUND/iu.test(text)) return "model-unreachable";
  if (/timed? ?out|timeout|deadline/iu.test(text)) return "timeout";
  return "other";
}

/** A failed step's output as the Governor stores and shows it: its error and stderr text with credentials hidden, everything else as it was. */
export function redactFailureOutput<T>(output: T): T {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const copy: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  for (const key of ["error", "stderr"]) if (typeof copy[key] === "string") copy[key] = redactSecrets(copy[key]);
  return copy as T;
}
