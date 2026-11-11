import type { ArtifactHistory } from "../../data/exec-outputs";

/**
 * A task's structured result, as the general-task workflow stores it: a short
 * summary, the written deliverable (Markdown), the per-criterion checklist and
 * the assumptions the worker made. Pure functions only; the reader component
 * renders them.
 */
export interface StructuredResult {
  summary: string;
  deliverable: string;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  assumptions: string[];
}

/** Parses an artifact's text when it is a task result; anything else is not (and stays a plain preview). */
export function parseStructuredResult(text: string): StructuredResult | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["deliverable"] !== "string" || typeof record["summary"] !== "string") return undefined;
  const criteria = Array.isArray(record["criteria"])
    ? record["criteria"].flatMap((entry): StructuredResult["criteria"] => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        return typeof row["criterion"] === "string" ? [{ criterion: row["criterion"], met: row["met"] === true, evidence: typeof row["evidence"] === "string" ? row["evidence"] : "" }] : [];
      })
    : [];
  const assumptions = Array.isArray(record["assumptions"]) ? record["assumptions"].filter((entry): entry is string => typeof entry === "string") : [];
  return { summary: record["summary"], deliverable: record["deliverable"], criteria, assumptions };
}

/** The whole result as one Markdown document: what Copy and Download .md hand over. */
export function resultMarkdown(result: StructuredResult): string {
  const parts = [result.summary.trim() ? `> ${result.summary.trim().replaceAll("\n", "\n> ")}` : "", result.deliverable.trim()];
  if (result.criteria.length)
    parts.push(`## Checklist\n\n${result.criteria.map((row) => `- [${row.met ? "x" : " "}] ${row.criterion}${row.evidence ? ` (${row.evidence})` : ""}`).join("\n")}`);
  if (result.assumptions.length) parts.push(`## Assumptions\n\n${result.assumptions.map((row) => `- ${row}`).join("\n")}`);
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** A file name for the downloaded Markdown, from the task or document title. */
export function markdownFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
  return `${slug || "result"}.md`;
}

export type TrustTone = "green" | "amber" | "red" | "gray";

export interface TrustLine {
  tone: TrustTone;
  /** One plain sentence a person can read without knowing what an evidence bundle is. */
  text: string;
  /** True when an independent reviewer approved it. */
  checked: boolean;
}

/**
 * The plain trust line under a Result (issue #49): whether an independent
 * reviewer checked the work and how many acceptance criteria it met. The
 * verdict comes from the artifact's history; the criteria counts come from the
 * result's own checklist.
 */
export function trustLineOf(history: ArtifactHistory | undefined, result?: StructuredResult): TrustLine {
  const outcome = history?.history.find((version) => version.verification)?.verification?.outcome;
  const total = result?.criteria.length ?? 0;
  const met = result?.criteria.filter((row) => row.met).length ?? 0;
  if (outcome === "verified")
    return { tone: "green", checked: true, text: total > 0 ? `Checked by an independent reviewer: ${met} of ${total} criteria met` : "Checked by an independent reviewer: it passed" };
  if (outcome === "rejected")
    return { tone: "red", checked: false, text: "An independent reviewer found problems with this result. Ask for changes or read why on the task." };
  if (outcome === "incomplete")
    return { tone: "amber", checked: false, text: "The independent check could not finish, so this result is not confirmed yet." };
  return { tone: "gray", checked: false, text: "Not independently checked yet. A separate reviewer checks the work against its criteria once the task finishes." };
}
