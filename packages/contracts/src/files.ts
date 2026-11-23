import { z } from "zod";
import { isCron } from "./cron";
import { LIMIT_DEFAULTS } from "./limits";
import type { Digest, JsonValue } from "./protocol";
import { isSlug, SLUG } from "./slug";

/** The files of a workspace folder and of a pack (docs/model.md): zod schemas, parsed types, and the step template syntax. Unknown keys are errors. */

const slug = (what: string) => z.string().regex(SLUG, `${what} must be lower-case letters, digits and dashes, starting with a letter`);
/** A tool is named by its folder: slugs joined by dots, such as `git.open-pr`. */
export const isToolName = (name: string): boolean => name.length <= 80 && name.split(".").every((part) => SLUG.test(part));
const packRef = z.string().refine((ref) => { const [name = "", pin, ...more] = ref.split("@"); return SLUG.test(name) && more.length === 0 && (pin === undefined || /^[1-9][0-9]{0,5}$/u.test(pin)); }, "a pack is its name, or its name and a release such as base@2");
/** A pack entry of brain.toml split into its name and the release it pins (0: the shipped baseline). */
export const splitPackRef = (ref: string): { readonly name: string; readonly pin: number } => {
  const [name = "", pin] = ref.split("@");
  return { name, pin: pin === undefined ? 0 : Number(pin) };
};
const toolName = z.string().refine(isToolName, "a tool name must be lower-case words joined by dots, such as deploy.restart");
export { isSlug };

/** A secret is named in a file, never written in one. */
const SECRET_REF = /^secret:[a-z][a-z0-9-]{0,62}$/u;
const secretRef = z.string().regex(SECRET_REF, "must be a reference written secret:<name>; the secret itself is set in the app");
export const secretName = (ref: string): string => ref.slice("secret:".length);
const host = z.string().refine((value) => {
  const [name = "", port, ...more] = value.split(":");
  return /^[A-Za-z0-9*.-]{1,253}$/u.test(name) && more.length === 0 && (port === undefined || /^\d{1,5}$/u.test(port));
}, "must be a host name, optionally with a port");
/** True for a time zone name the runtime knows (IANA, such as `Africa/Tunis`). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
/** A git remote the Governor pushes to: an http or https address, with no user or password written in it. */
const isRemoteAddress = (value: string): boolean => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.host !== ""; } catch { return false; }
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be a date written YYYY-MM-DD");

export const EFFECTS = ["read", "write", "privileged"] as const;
export const NATIVE_LEVELS = ["none", "read", "all"] as const;
/** The tools the Governor runs itself (`runs = "brain"`). */
export const BRAIN_TOOLS = ["task.create", "task.note", "task.ask", "memory.search", "memory.propose", "git.open-pr", "message.send", "workspace.fix", "platform.workspaces", "platform.tasks", "platform.task", "platform.file", "platform.repeats", "platform.tool-drift"] as const;
/** The pack only the platform workspace may list, and the prefix of the Brain-run tools it holds. */
export const PLATFORM_PACK = "platform";
/** `admin`: the one workspace that keeps, edits and releases the packs and also reads the others. `read`: reads the others and nothing more. */
export const PLATFORM_KINDS = ["admin", "read"] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

// --- translations: what a person reads, in the page's language; agents read the English ---

export const LANGUAGES = ["fr", "ar"] as const;
export type Language = (typeof LANGUAGES)[number];
export const isLanguage = (value: string): value is Language => (LANGUAGES as readonly string[]).includes(value);
const INPUT_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
/** `[translations.fr]` and `[translations.ar]`: the human-facing keys of the file, and nothing else. Optional in every language. */
const translations = <S extends z.ZodRawShape>(shape: S) => z.strictObject({ fr: z.strictObject(shape).optional(), ar: z.strictObject(shape).optional() }).optional();
const translatedInputs = z.record(z.string().regex(INPUT_NAME), z.strictObject({ description: z.string() })).optional();
/** A translation of an input names an input the file has. */
function translatedInputsExist(file: { inputs: Record<string, unknown>; translations?: Partial<Record<Language, { inputs?: Record<string, unknown> | undefined } | undefined>> | undefined }, ctx: z.RefinementCtx): void {
  for (const lang of LANGUAGES) for (const name of Object.keys(file.translations?.[lang]?.inputs ?? {})) {
    if (!(name in file.inputs)) ctx.addIssue({ code: "custom", path: ["translations", lang, "inputs", name], message: `translates the input ${name}, which the file does not have` });
  }
}

// --- inputs of a tool or a Play ---

const INPUT_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
const inputEnum = z.array(z.union([z.string(), z.number(), z.boolean()])).min(1);
export const InputSpec = z.strictObject({
  type: z.enum(INPUT_TYPES),
  description: z.string().default(""),
  required: z.boolean().default(false),
  enum: inputEnum.optional(),
  items: z.strictObject({ type: z.enum(INPUT_TYPES), enum: inputEnum.optional() }).optional(),
}).refine((spec) => spec.items === undefined || spec.type === "array", { path: ["items"], message: "items is only for an input of type array" });
export type InputSpec = z.infer<typeof InputSpec>;
const inputs = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u, "an input name must be lower-case letters, digits and underscores"), InputSpec).default({});
export type JsonSchema = { readonly [key: string]: JsonValue };

// --- brain.toml ---

/** `"6h"`: hours, or `"5 rounds"`: work attempts (docs/model.md, "Checkpoints"). */
export const CHECKPOINT = /^([1-9]\d{0,3})(h| rounds)$/u;
const checkpoint = z.string().regex(CHECKPOINT, 'must be hours such as "6h" or work attempts such as "5 rounds"');

export const BrainFile = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  /** The IANA time zone schedules are read in. */
  timezone: z.string().refine(isTimeZone, "must be an IANA time zone name, such as Europe/Paris").default("UTC"),
  /** `private`: only members see the workspace. `public`: every signed-in person of this Brain reads it, as a viewer. */
  visibility: z.enum(["private", "public"]).default("private"),
  /** A platform workspace (docs/model.md, "The platform workspace"): `admin` is the one that keeps the packs, `read` only reads the others. Only a platform administrator may set it. */
  platform: z.enum(PLATFORM_KINDS).optional(),
  /** `<name>` is the shipped pack, `<name>@<n>` release `n` of it (docs/model.md, "The platform workspace"). */
  packs: z.array(packRef).default([]),
  limits: z.strictObject({
    daily_spend_usd: z.number().min(0).default(LIMIT_DEFAULTS.daily_spend_usd),
    running_tasks: z.int().min(0).max(64).default(LIMIT_DEFAULTS.running_tasks),
    confirm_plans: z.enum(["person", "auto"]).default("person"),
    /** True: nothing of this workspace starts; what runs goes on. */
    paused: z.boolean().default(false),
    /** A goal with no Play pauses for a person this often; an unanswered checkpoint stops it after `checkpoint_timeout` (docs/model.md, "Checkpoints"). */
    checkpoint: checkpoint.optional(),
    checkpoint_timeout: z.string().regex(/^([1-9]\d{0,3})h$/u, 'must be hours such as "24h"').default("24h"),
  }).prefault({}),
  /** What happens when a task has failed all its attempts: a heal task analyses it. `per_day` is the heal tasks of a UTC day; 0 is no cap. */
  healing: z.strictObject({ mode: z.enum(["auto", "off"]).default("auto"), per_day: z.int().min(0).default(LIMIT_DEFAULTS.healing_per_day) }).prefault({}),
  /** A goal waiting for a person is closed when a newer identical one has a result and it has waited this many hours; 0 is never. */
  cleanup: z.strictObject({ superseded_after_hours: z.int().min(0).default(24) }).prefault({}),
  model: z.array(z.strictObject({
    name: slug("a model name"),
    provider: z.enum(["openai-compatible", "anthropic"]),
    url: z.string().regex(/^https?:\/\/\S+$/u, "must be an http or https address"),
    model: z.string().min(1),
    key: secretRef.optional(),
    /** What a million tokens cost, in dollars: the gateway prices a call with them when the model server reports no cost. */
    input_usd_per_mtok: z.number().min(0).optional(),
    output_usd_per_mtok: z.number().min(0).optional(),
    /** The model's context window in tokens (default 200000): an engine that keeps a long conversation compacts it before this is reached. */
    context_tokens: z.int().min(8192).optional(),
    /** The share of the window at which the conversation is compacted (default 0.7): the rest is room for the next tool result and reply. */
    compact_at: z.number().min(0.3).max(0.95).optional(),
  })).default([]),
  project: z.array(z.strictObject({
    name: slug("a project name"),
    repo: z.string().min(1).refine((value) => !value.startsWith("-"), "a repository address does not start with a dash"),
    branch: z.string().min(1).default("main"),
    access: z.enum(["read", "write"]).default("write"),
    credential: secretRef.optional(),
    setup: z.string().min(1).optional(),
    /** Hosts the project's sandbox may reach. Left out, any public host (`"*"`); `[]` is no network at all. */
    network: z.array(host).default(["*"]),
  })).default([]),
  github: z.strictObject({ credential: secretRef, webhook_secret: secretRef.optional() }).optional(),
  /** A git remote that receives the workspace folder after every commit (docs/model.md, "A workspace folder"). `credential` defaults to the GitHub one. */
  git: z.strictObject({ remote: z.string().refine(isRemoteAddress, "must be an http or https address without a password in it"), credential: secretRef.optional() }).optional(),
  teams: z.strictObject({ webhook: secretRef }).optional(),
  approvals: z.record(toolName, z.strictObject({ targets: z.array(z.string().min(1)).min(1), per_day: z.int().min(1), until: day })).default({}),
});
export type BrainFile = z.infer<typeof BrainFile>;

// --- agents/<name>/agent.toml ---


export const AgentFile = z.strictObject({
  description: z.string().min(1),
  engine: z.array(slug("an engine name")).min(1),
  native: z.enum(NATIVE_LEVELS).default("none"),
  tools: z.array(toolName).default([]),
  model: slug("a model name").optional(),
  limits: z.strictObject({
    turns: z.int().min(0).default(LIMIT_DEFAULTS.turns),
    tokens: z.int().min(0).default(LIMIT_DEFAULTS.tokens),
    spend_usd: z.number().min(0).default(LIMIT_DEFAULTS.spend_usd),
  }).prefault({}),
  translations: translations({ description: z.string().min(1).optional() }),
});
export type AgentFile = z.infer<typeof AgentFile>;

// --- tools/<name>/tool.toml ---

export const ToolFile = z.strictObject({
  description: z.string().min(1),
  effect: z.enum(EFFECTS),
  timeout_seconds: z.int().min(1).max(3600).default(60),
  needs: z.array(slug("a runner capability")).default([]),
  /** Hosts the tool may reach. Left out, any public host (`"*"`); `[]` is no network at all. */
  network: z.array(host).default(["*"]),
  secrets: z.array(slug("a secret name")).default([]),
  runs: z.literal("brain").optional(),
  host_command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u, "must be the name of a command declared on the runner host").optional(),
  inputs,
  translations: translations({ description: z.string().min(1).optional(), inputs: translatedInputs }),
}).superRefine((tool, ctx) => {
  translatedInputsExist(tool, ctx);
  if (tool.runs !== undefined && tool.host_command !== undefined) ctx.addIssue({ code: "custom", path: ["host_command"], message: "a tool is run by Brain or by a host command, not both" });
  if (tool.host_command !== undefined && tool.effect === "write") ctx.addIssue({ code: "custom", path: ["effect"], message: "a host command that changes anything must have effect privileged" });
});
export type ToolFile = z.infer<typeof ToolFile>;

// --- plays/<name>.toml ---

const cron = z.string().refine((text) => text.trim().split(/\s+/u).length === 5 && isCron(text), "must be a five-field cron expression of numbers, lists, ranges and steps that names a time, such as 0 8 * * 1");
export const StepSpec = z.strictObject({
  id: slug("a step id"),
  agent: slug("an agent name").optional(),
  goal: z.string().min(1).optional(),
  after: z.array(slug("a step id")).default([]),
  for_each: z.string().min(1).optional(),
  review_by: slug("an agent name").optional(),
  max_rounds: z.int().min(1).max(10).default(LIMIT_DEFAULTS.max_rounds),
  target_score: z.number().min(0).max(1).optional(),
  candidates: z.union([z.int().min(2).max(8), z.array(slug("an agent name")).min(2).max(8)]).optional(),
  judge: slug("a judge").optional(),
  when: z.string().min(1).optional(),
  /** Memory entry names the step needs (`*` matches any run of characters): when one has no entry, the step is skipped. */
  requires: z.array(z.string().regex(/^[a-z0-9*][a-z0-9*._-]*$/u, "must be a memory entry name, with * for any run of characters")).default([]),
  approve: z.boolean().default(false),
});
export type StepSpec = z.infer<typeof StepSpec>;
export const PlayFile = z.strictObject({
  title: z.string().min(1).max(200),
  checkpoint: checkpoint.optional(),
  description: z.string().default(""),
  inputs,
  trigger: z.strictObject({
    schedule: cron.optional(),
    webhook: z.string().refine((value) => {
      const [source, ...event] = value.split(".");
      return source === "github" && (event.length === 1 || event.length === 2) && event.every((part) => /^[a-z_]+$/u.test(part));
    }, "must name a GitHub event, such as github.issues.opened").optional(),
    /** A paused schedule stays in the file and never fires. */
    paused: z.boolean().optional(),
  }).refine((trigger) => (trigger.schedule === undefined) !== (trigger.webhook === undefined), "a trigger has either schedule or webhook")
    .refine((trigger) => trigger.paused === undefined || trigger.schedule !== undefined, { path: ["paused"], message: "only a schedule can be paused" }).optional(),
  step: z.array(StepSpec).min(1),
  translations: translations({ title: z.string().min(1).max(200).optional(), description: z.string().optional(), inputs: translatedInputs }),
}).superRefine(translatedInputsExist);
export type PlayFile = z.infer<typeof PlayFile>;

// --- packs/<name>/pack.toml ---

export const PackFile = z.strictObject({
  name: slug("a pack name"),
  description: z.string().default(""),
  requires: z.array(slug("a pack name")).default([]),
  /** The last release of a copy kept in the platform workspace (none: not released yet). */
  version: z.int().min(1).optional(),
  translations: translations({ description: z.string().optional() }),
});
export type PackFile = z.infer<typeof PackFile>;

// --- memory/<name>.md ---

export const MemoryEntry = z.strictObject({ title: z.string().min(1).max(200), body: z.string() });
export type MemoryEntry = z.infer<typeof MemoryEntry>;
/** A memory entry is Markdown whose first line is its title (`# Title`). Returns what the schema is given; a file with no title line has an empty title. */
export function splitMemoryEntry(text: string): { title: string; body: string } {
  const [first = "", ...rest] = text.replace(/^﻿/u, "").trimStart().split("\n");
  return first.startsWith("# ") ? { title: first.slice(2).trim(), body: rest.join("\n").trim() } : { title: "", body: text.trim() };
}

/** `memory/<name>.<lang>.md`: the entry written for people who read that language. Agents never see it. Returns the entry's name and language. */
export function parseMemoryTranslationName(file: string): { name: string; lang: Language } | undefined {
  const found = /^([a-z][a-z0-9-]{0,62})\.(fr|ar)\.md$/u.exec(file);
  return found ? { name: found[1] as string, lang: found[2] as Language } : undefined;
}

// --- documents: any other file of the workspace folder ---

/** The most a file of a workspace may be, and the most one write may carry, in bytes. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_WRITE_BYTES = 20 * 1024 * 1024;
/** Documents `memory.search` finds: text under `docs/`, at most this long. */
export const MAX_INDEXED_BYTES = 1024 * 1024;
const INDEXED = /^docs\/.+\.(?:md|markdown|txt|rst|csv|json|ya?ml)$/iu;
export const isIndexedDocument = (path: string): boolean => INDEXED.test(path);
/** Why a path cannot be a file of a workspace folder, or undefined when it can. Hidden names are refused, except the `.gitkeep` that keeps an empty folder. */
export function pathProblem(path: string): string | undefined {
  if (path.length > 300) return "a path is at most 300 characters";
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return "a path has no backslash or control character";
  const parts = path.split("/");
  if (parts.length > 12) return "a path is at most 12 folders deep";
  for (const [index, part] of parts.entries()) {
    if (part === "") return "a path has no empty part: no leading, trailing or double slash";
    if (part === "." || part === "..") return "a path cannot contain . or ..";
    if (part.startsWith(".") && !(part === ".gitkeep" && index === parts.length - 1)) return "a name cannot start with a dot, except .gitkeep";
    if (part.length > 120) return "a name is at most 120 characters";
  }
  return undefined;
}

// --- step templates: {{input}}, {{steps.<id>.result[.field]}}, {{item[.field]}} ---

export type Ref =
  | { readonly kind: "input"; readonly name: string; readonly path: readonly string[] }
  | { readonly kind: "step"; readonly step: string; readonly path: readonly string[] }
  | { readonly kind: "item"; readonly path: readonly string[] };

/** Reads one reference, without braces. Undefined when it is not one. */
export function parseRef(text: string): Ref | undefined {
  const parts = text.trim().split(".");
  const [head, second, third] = parts;
  if (head === undefined || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  if (head === "item") return { kind: "item", path: parts.slice(1) };
  if (head === "steps") return second !== undefined && third === "result" ? { kind: "step", step: second, path: parts.slice(3) } : undefined;
  return { kind: "input", name: head, path: parts.slice(1) };
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;
/** Every `{{...}}` of a text, with the reference it holds (undefined when it holds none). */
export function templateRefs(text: string): Array<{ raw: string; ref: Ref | undefined }> {
  return [...text.matchAll(PLACEHOLDER)].map((match) => ({ raw: match[0], ref: parseRef(match[1] ?? "") }));
}
/** Replaces every `{{...}}` with its value: a string as it is, anything else as JSON, and nothing for a value that does not exist. */
export function renderTemplate(text: string, resolve: (ref: Ref) => JsonValue | undefined): string {
  return text.replace(PLACEHOLDER, (_raw, inner: string) => {
    const ref = parseRef(inner);
    const value = ref ? resolve(ref) : undefined;
    return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  });
}

export interface When { readonly ref: Ref; readonly op: "==" | "!="; readonly value: string | number | boolean }
/** Reads a step's `when`: one reference (braces optional), `==` or `!=`, and a quoted string, a number or a boolean. */
export function parseWhen(text: string): When | undefined {
  const at = text.search(/[=!]=/u);
  if (at < 0) return undefined;
  const left = text.slice(0, at).trim();
  const right = text.slice(at + 2).trim();
  const ref = parseRef(left.startsWith("{{") && left.endsWith("}}") ? left.slice(2, -2) : left);
  const quoted = /^"([^"]*)"$|^'([^']*)'$/u.exec(right);
  const value = quoted ? (quoted[1] ?? quoted[2] ?? "") : right === "true" ? true : right === "false" ? false : right !== "" && Number.isFinite(Number(right)) ? Number(right) : undefined;
  return ref && value !== undefined ? { ref, op: text.slice(at, at + 2) as When["op"], value } : undefined;
}

// --- the snapshot: one manifest of everything a workspace folder and its packs hold ---

export interface FileRef { readonly path: string; readonly digest: Digest; readonly bytes: number }
/** Where a file came from: `workspace`, or the name of the pack that supplied it. */
export interface Sourced { readonly source: string }
export interface SnapshotManifest {
  readonly name: string;
  readonly description: string;
  readonly timezone: string;
  readonly visibility: "private" | "public";
  /** Present only for a platform workspace. */
  readonly platform?: PlatformKind;
  /** Every pack in use, required packs first. */
  readonly packs: readonly string[];
  /** The release each pinned pack is used at; left out when none is pinned. */
  readonly pins?: Readonly<Record<string, number>>;
  readonly limits: BrainFile["limits"];
  readonly healing: BrainFile["healing"];
  readonly cleanup: BrainFile["cleanup"];
  readonly models: BrainFile["model"];
  readonly projects: BrainFile["project"];
  readonly github: BrainFile["github"] | null;
  /** The remote the folder is pushed to; left out when there is none. */
  readonly git?: NonNullable<BrainFile["git"]>;
  readonly teams: BrainFile["teams"] | null;
  readonly approvals: BrainFile["approvals"];
  readonly agents: Readonly<Record<string, AgentFile & Sourced & { readonly prompt: { readonly digest: Digest; readonly bytes: number } }>>;
  /** `files` are the files beside `tool.toml` (`run.sh`, `test.sh`, ...); `input_schema` is the JSON Schema a call's input must satisfy. */
  readonly tools: Readonly<Record<string, ToolFile & Sourced & { readonly input_schema: JsonSchema; readonly files: readonly FileRef[] }>>;
  readonly plays: Readonly<Record<string, PlayFile & Sourced>>;
  /** `titles` are the titles of the entry's translations (`memory/<name>.fr.md`), which only people read. */
  readonly memory: ReadonlyArray<Sourced & { readonly name: string; readonly title: string; readonly titles: Readonly<Partial<Record<Language, string>>>; readonly digest: Digest; readonly bytes: number }>;
  /** The text documents of the workspace under `docs/` that agents can search. */
  readonly documents: ReadonlyArray<{ readonly path: string; readonly title: string; readonly digest: Digest; readonly bytes: number }>;
}
/** One thing wrong with a workspace folder: the file and what to fix. */
export interface Problem { readonly path: string; readonly message: string }
