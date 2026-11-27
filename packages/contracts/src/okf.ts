import { parse, parseDocument, stringify } from "yaml";

/**
 * Open Knowledge Format 0.3 (github.com/open-knowledge-format/open-knowledge-format, SPEC.md): a concept is a Markdown file that starts
 * with YAML frontmatter naming its `type`. Brain's memory entries are concepts (docs/model.md, Memory). A key Brain does not use is left
 * alone, and a trust, status or freshness key it cannot read counts for nothing rather than refusing the file.
 */

/** Names the format keeps for a bundle's listing and history: a file of that name is never a concept. */
export const isReserved = (name: string): boolean => name === "index" || name === "log";

/** Who has checked a concept, as the format derives it from `verified`. */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export interface ConceptFacts {
  readonly type: string;
  readonly trust: TrustTier;
  readonly description?: string;
  /** Left out when the concept is stable, which is what an absent `status` means. */
  readonly status?: string;
  /** As written: from this time on the concept is to be checked again. */
  readonly staleAfter?: string;
}
export interface Concept { readonly facts: ConceptFacts; readonly title?: string; readonly tags: readonly string[]; readonly body: string }

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)(?<=\n)---\r?(?:\n|$)/u;
/** The keys that say who made and checked a concept, and whether it still holds: changing one of them does not change what the concept says. */
const ABOUT = new Set(["generated", "verified", "status", "stale_after", "superseded_by"]);

type Fields = Record<string, unknown>;
const mapping = (value: unknown): Fields | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
/** A list field may hold one item written without its list; an absent, null or empty value is no item. */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}[.\d]*(?:[Zz]|[+-]\d{2}:\d{2})$/u;
/** An RFC 3339 date-time with its offset, or a date (the start of that day, UTC), in milliseconds; undefined for anything else. */
export function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string" || !(DATE.test(value) || DATE_TIME.test(value))) return undefined;
  const time = Date.parse(value.replace(" ", "T").toUpperCase());
  return Number.isNaN(time) ? undefined : time;
}

/** Whether the concept is to be checked again. A `stale_after` that cannot be read is never taken as fresh. */
export const isStale = (facts: Pick<ConceptFacts, "staleAfter">, nowMs: number): boolean => facts.staleAfter !== undefined && nowMs >= (timeOf(facts.staleAfter) ?? 0);

/** The content's last meaningful change (`generated.at`): the start of time when it does not say, never reached when it cannot be read. */
function sinceOf(fields: Fields): number {
  const written = mapping(fields["generated"])?.["at"];
  return written === undefined || written === null || written === "" ? -Infinity : (timeOf(written) ?? Infinity);
}

/** A verification counts when it is no older than the content. */
function trustOf(fields: Fields, events: readonly unknown[] = list(fields["verified"])): TrustTier {
  const since = sinceOf(fields);
  const current = events.flatMap((event) => {
    const by = text(mapping(event)?.["by"]);
    const at = timeOf(mapping(event)?.["at"]);
    return by !== undefined && at !== undefined && at >= since ? [by] : [];
  });
  return current.length === 0 ? "unverified" : current.some((by) => by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

function split(source: string): { readonly fields: Fields; readonly yaml: string; readonly body: string } | { readonly problem: string } {
  const found = FRONTMATTER.exec(source);
  if (!found) return { problem: "it starts with no frontmatter" };
  let value: unknown;
  try { value = parse(found[1] ?? ""); } catch (e) { return { problem: `the frontmatter is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` }; }
  const fields = value === null ? {} : mapping(value);
  return fields ? { fields, yaml: found[1] ?? "", body: source.slice(found[0].length).trim() } : { problem: "the frontmatter is not a list of `key: value` lines" };
}

/** The file as a concept, or why it is not one. */
export function readConcept(source: string): Concept | { readonly problem: string } {
  const read = split(source);
  if ("problem" in read) return read;
  const { fields, body } = read;
  const type = text(fields["type"]);
  if (type === undefined) return { problem: "its frontmatter has no `type`" };
  const description = text(fields["description"]);
  const status = text(fields["status"]);
  const stale = fields["stale_after"];
  const title = text(fields["title"]);
  return {
    facts: {
      type, trust: trustOf(fields), ...(description === undefined ? {} : { description }), ...(status === undefined || status === "stable" ? {} : { status }),
      ...(stale === undefined || stale === null || stale === "" ? {} : { staleAfter: String(stale) }),
    },
    ...(title === undefined ? {} : { title }),
    tags: list(fields["tags"]).flatMap((tag) => text(typeof tag === "number" ? String(tag) : tag) ?? []),
    body,
  };
}

/** A concept file: its frontmatter, then its body. */
export const conceptText = (fields: Readonly<Fields>, body: string): string => `---\n${stringify(fields, { lineWidth: 0 })}---\n\n${body.trim() === "" ? "" : `${body.trim()}\n`}`;

const ordered = (value: unknown): string => JSON.stringify(value, (_key, held) => (mapping(held) ? Object.fromEntries(Object.entries(held as Fields).sort(([a], [b]) => (a < b ? -1 : 1))) : held));

/**
 * What to write instead of `after` when it changes what a concept says but keeps a claim made of the text before: a verification that
 * would still count, the same `generated`, or an older one. `generated` then names who changed it and when, so an earlier verification no
 * longer counts and stays as history. Undefined when `after` can be written as it is.
 */
export function restamped(before: string, after: string, by: string, at: string): string | undefined {
  const was = split(before);
  const is = split(after);
  if ("problem" in was || "problem" in is) return undefined;
  const said = (read: { fields: Fields; body: string }): string => ordered([Object.fromEntries(Object.entries(read.fields).filter(([key]) => !ABOUT.has(key))), read.body]);
  if (said(was) === said(is)) return undefined;
  const checked = new Set(list(was.fields["verified"]).map(ordered));
  const carried = list(is.fields["verified"]).filter((event) => checked.has(ordered(event)));
  const writer = was.fields["generated"];
  const keptWriter = writer !== undefined && (ordered(writer) === ordered(is.fields["generated"]) || (is.fields["generated"] !== undefined && sinceOf(is.fields) < sinceOf(was.fields)));
  if (!keptWriter && trustOf(is.fields, carried) === "unverified") return undefined;
  const frontmatter = parseDocument(is.yaml);
  frontmatter.set("generated", { by, at });
  return `---\n${frontmatter.toString({ lineWidth: 0 })}---\n${after.slice((FRONTMATTER.exec(after) as RegExpExecArray)[0].length)}`;
}
