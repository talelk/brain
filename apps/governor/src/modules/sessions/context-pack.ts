import { createHash } from "node:crypto";

/**
 * The context pack a session receives (issues #80, #81): an ordered, budgeted
 * text the Governor builds from declared sections only, plus a manifest that
 * says what was included, estimated, truncated and where the full text lives.
 *
 * Compaction is deterministic and never a model summary: facts, accepted
 * decisions and the last failure are kept whole; prose is truncated at
 * sentence boundaries with progressively smaller caps and, last, replaced by a
 * reference (a content-addressed artifact the agent or a person can fetch).
 */

export const CHARS_PER_TOKEN = 4;
export const ESTIMATE_NOTE = "Estimated at 4 characters per token before the run; the engine's usage events record actual tokens.";
/** Prose is truncated to these caps, longest first, until the pack fits. */
const TRUNCATION_CAPS = [1200, 600, 300, 150] as const;

export type SectionLabel = "fact" | "claim" | "reference";

export interface PackItem {
  readonly id: string;
  readonly text: string;
  /** Prose may be truncated or replaced by a reference; everything else is kept whole. */
  readonly prose: boolean;
}

export interface PackSection {
  readonly id: string;
  readonly title: string;
  /** fact: derived or owner-authored; claim: written by a member or a person and not verified; reference: pointers only. */
  readonly label: SectionLabel;
  readonly items: readonly PackItem[];
}

export interface ManifestSection {
  readonly id: string;
  readonly title: string;
  readonly label: SectionLabel;
  readonly items: number;
  readonly estimatedTokens: number;
  readonly sourceDigest: string;
}

export interface ManifestTruncation {
  readonly sectionId: string;
  readonly itemId: string;
  readonly mode: "truncated" | "referenced";
  readonly originalTokens: number;
  readonly keptTokens: number;
  /** `artifact:sha256:...`: the full text, fetchable through a read tool or the run page. */
  readonly reference: string;
}

export interface ContextManifest {
  readonly contractVersion: "brain.context-manifest/v1";
  readonly runId: string;
  readonly jobId: string;
  readonly workItemId: string;
  readonly agentId: string;
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly estimateNote: string;
  readonly overBudget: boolean;
  readonly sections: readonly ManifestSection[];
  readonly truncations: readonly ManifestTruncation[];
  readonly textDigest: string;
}

export interface BuiltPack {
  readonly text: string;
  readonly manifest: ContextManifest;
  /** Full texts behind every truncation, keyed by reference. */
  readonly bodies: ReadonlyMap<string, string>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
export const referenceOf = (text: string): string => `artifact:${sha(text)}`;

/** Cuts at the last sentence end within the cap, else at the last word break, never mid-word. */
export function truncateAtSentence(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  let cut = -1;
  for (const mark of [". ", ".\n", "! ", "? ", "!\n", "?\n", "\n\n"]) cut = Math.max(cut, head.lastIndexOf(mark) + (mark.startsWith("\n") ? 0 : 1));
  if (cut < cap * 0.4) cut = head.lastIndexOf(" ");
  if (cut <= 0) cut = cap;
  return head.slice(0, cut).trimEnd();
}

type Mode = { readonly kind: "full" } | { readonly kind: "truncated"; readonly cap: number } | { readonly kind: "referenced" };

function itemText(item: PackItem, mode: Mode): string {
  if (mode.kind === "full") return item.text;
  const ref = referenceOf(item.text);
  if (mode.kind === "referenced") return `[${estimateTokens(item.text)} estimated tokens not included; full text: ${ref}]`;
  return `${truncateAtSentence(item.text, mode.cap)} [truncated; full text: ${ref}]`;
}

const LABELS: Record<SectionLabel, string> = { fact: "fact", claim: "claim, not verified", reference: "reference" };

function render(sections: readonly PackSection[], modes: ReadonlyMap<string, Mode>): { text: string; perSection: Map<string, string> } {
  const perSection = new Map<string, string>();
  const parts = ["# Context assembled by Brain for this task", "Sections marked claim were written by people or agents and are not verified. Only sections listed here are provided."];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    const body = section.items.map((item) => itemText(item, modes.get(`${section.id}/${item.id}`) ?? { kind: "full" })).join("\n");
    perSection.set(section.id, body);
    parts.push(`## ${section.title} [${LABELS[section.label]}]\n${body}`);
  }
  return { text: parts.join("\n\n"), perSection };
}

export function buildContextPack(input: {
  readonly sections: readonly PackSection[];
  readonly budgetTokens: number;
  readonly identity: { readonly runId: string; readonly jobId: string; readonly workItemId: string; readonly agentId: string };
}): BuiltPack {
  const { sections, budgetTokens } = input;
  const modes = new Map<string, Mode>();
  const fits = (): boolean => estimateTokens(render(sections, modes).text) <= budgetTokens;
  const prose = sections.flatMap((section) => section.items.filter((item) => item.prose).map((item) => ({ key: `${section.id}/${item.id}`, item })));

  if (!fits()) {
    for (const cap of TRUNCATION_CAPS) {
      for (const { key, item } of prose) if (item.text.length > cap) modes.set(key, { kind: "truncated", cap });
      if (fits()) break;
    }
  }
  if (!fits()) {
    // Largest prose first; ties break on the key so repeat runs agree.
    for (const { key, item } of [...prose].sort((a, b) => b.item.text.length - a.item.text.length || a.key.localeCompare(b.key))) {
      modes.set(key, { kind: "referenced" });
      if (fits()) break;
    }
  }

  const { text, perSection } = render(sections, modes);
  const bodies = new Map<string, string>();
  const truncations: ManifestTruncation[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      const mode = modes.get(`${section.id}/${item.id}`);
      if (!mode || mode.kind === "full") continue;
      const reference = referenceOf(item.text);
      bodies.set(reference, item.text);
      truncations.push({
        sectionId: section.id, itemId: item.id, mode: mode.kind, originalTokens: estimateTokens(item.text),
        keptTokens: estimateTokens(itemText(item, mode)), reference,
      });
    }
  }
  const estimated = estimateTokens(text);
  const manifest: ContextManifest = {
    contractVersion: "brain.context-manifest/v1", ...input.identity, budgetTokens, estimatedTokens: estimated, estimateNote: ESTIMATE_NOTE,
    overBudget: estimated > budgetTokens,
    sections: sections.filter((section) => section.items.length > 0).map((section) => ({
      id: section.id, title: section.title, label: section.label, items: section.items.length,
      estimatedTokens: estimateTokens(perSection.get(section.id) ?? ""), sourceDigest: sha(section.items.map((item) => `${item.id}\n${item.text}`).join("\n\n")),
    })),
    truncations, textDigest: sha(text),
  };
  return { text, manifest, bodies };
}
