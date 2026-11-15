import type { Skill } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { BrainDomainError } from "../../domain/errors";
import { looksLikeSecret } from "../knowledge/index";

/**
 * A Skill is a release document whose text is added to an agent's instructions for a task that names one of its triggers. It is
 * instructions and nothing else: the tools, permissions and effect classes an agent has come from its own pinned document and the
 * policy floor, never from a skill. Compilation therefore refuses a skill that tries to declare any of them or tells the agent to
 * get around them. The prose scan is a heuristic and the second line; the first is that the runner never reads a tool from a skill.
 */
export const MAX_SKILL_BYTES = 16 * 1024;
/** What one agent may pin in total, so a task that matches several of them still leaves room for the work. */
export const MAX_AGENT_SKILL_BYTES = 48 * 1024;

export interface CompiledSkill { readonly digest: string; readonly description: string; readonly triggers: readonly string[]; readonly text: string }

const normalize = (key: string): string => key.toLowerCase().replace(/[-_\s]/gu, "");
/** Keys that grant or change what an agent can do. A skill has no such field, whatever file format it is written in. */
const WIDENING_KEYS = new Set(["tools", "allowedtools", "disallowedtools", "permissions", "permission", "effectclass", "allowedhosts", "engine", "maxturns", "maxtokens", "maxmicrousd", "maxchildren", "env", "secrets", "mcp", "mcpservers", "hooks", "model", "autonomy", "approvals"]);
/** Keys that, as a line of the text, read as a declaration of access rather than prose. */
const WIDENING_LINE_KEYS = new Set(["allowedtools", "effectclass", "allowedhosts", "permissions"]);
const BYPASS: readonly RegExp[] = [
  /(?<!(?:\bnot|\bnever|n\x27t)\s+)\b(?:ignore|bypass|override|disable|skip|circumvent|turn off|get around)\b[^.\n]{0,60}\b(?:approvals?|gates?|allow-?lists?|allowed tools|permissions?|polic(?:y|ies)|sandbox|guardrails?|effect class(?:es)?|restrictions?)\b/iu,
  /\b(?:you (?:may|can|are (?:allowed|free) to)|feel free to)(?!\x27t\b|\s+(?:not|never)\b)\b[^.\n]{0,40}\b(?:any|every|all|other|unlisted|additional)\b[^.\n]{0,20}\btools?\b/iu,
  /(?<!(?:\bnot|\bnever|n\x27t)\s+)\b(?:grant (?:yourself|the agent)|escalate (?:your )?(?:privileges|permissions))\b|--dangerously-skip-permissions/iu,
];

function widenError(id: string, reason: string): BrainDomainError {
  return new BrainDomainError("INVALID_CONTRACT", `Skill ${id} widens tools or permissions: ${reason}`);
}

/** The keys a Markdown file declares between a leading pair of --- lines (a native skill's front matter), if it has one. */
function frontMatterKeys(text: string): string[] {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return [];
  return (match[1] ?? "").split(/\r?\n/u).map((line) => /^([A-Za-z][\w -]*?)\s*:/u.exec(line)?.[1]).filter((key): key is string => key !== undefined);
}

/** Validates one Skill document and returns what the release keeps of it. Throws the reason it cannot be released. */
export function compileSkill(raw: Record<string, unknown>, path: string, id: string, digest: string): CompiledSkill {
  const spec = (raw["spec"] ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(spec)) if (WIDENING_KEYS.has(normalize(key))) throw widenError(id, `spec.${key}`);
  const check = validate("Skill", raw);
  if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", `${path}: ${check.errors.join("; ")}`);
  const skill = raw as unknown as Skill;
  const { description, triggers, text } = skill.spec;
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new BrainDomainError("PAYLOAD_TOO_LARGE", `Skill ${id} exceeds ${MAX_SKILL_BYTES / 1024} KiB`);
  if ([description, text, ...triggers].some((value) => looksLikeSecret(value))) throw new BrainDomainError("INVALID_CONTRACT", `Skill ${id} appears to contain a secret; remove it from the skill`);
  for (const key of frontMatterKeys(text)) if (WIDENING_KEYS.has(normalize(key))) throw widenError(id, `front matter key ${key}`);
  for (const line of text.split(/\r?\n/u)) {
    const key = /^\s*[-*]?\s*([A-Za-z][\w-]*)\s*:/u.exec(line)?.[1];
    if (key && WIDENING_LINE_KEYS.has(normalize(key))) throw widenError(id, key);
  }
  for (const pattern of BYPASS) {
    const hit = pattern.exec(text);
    if (hit) throw widenError(id, `it tells the agent to bypass a control ("${hit[0].trim().slice(0, 80)}")`);
  }
  return { digest, description, triggers: [...triggers], text };
}
