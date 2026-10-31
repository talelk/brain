import type { SourceDoc } from "./compiler";

export interface DocumentDiff {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly unified: string;
}

function unified(path: string, before: string | null, after: string | null): string {
  if (before === after) return "";
  const oldLines = before?.split("\n") ?? [];
  const newLines = after?.split("\n") ?? [];
  return [`--- ${path} (active)`, `+++ ${path} (draft)`, ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n");
}

export function diffDocuments(active: readonly SourceDoc[], draft: readonly SourceDoc[]): DocumentDiff[] {
  const before = new Map(active.map((document) => [document.path, document.text] as const));
  const after = new Map(draft.map((document) => [document.path, document.text] as const));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((path) => {
    const oldText = before.get(path) ?? null;
    const newText = after.get(path) ?? null;
    return { path, before: oldText, after: newText, unified: unified(path, oldText, newText) };
  }).filter((entry) => entry.unified.length > 0);
}
