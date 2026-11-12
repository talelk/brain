import { sha256Digest } from "@brain/contracts";
import type { SourceDoc } from "./compiler";

const digestOf = (text: string): string => sha256Digest(new TextEncoder().encode(text));

/**
 * The documents that must change because a draft changed a definition they pin by digest. An agent pins its tools and a workflow pins its
 * agents by the digest of their source text, so editing a Tool's definition moves its digest and everything above it must follow.
 * Returns only the rewritten dependents (never the draft's own documents), followed to a fixed point: tool -> agent -> workflow.
 * A script-only edit leaves the definition's text, and so every pin, untouched.
 */
export function repinDependents(active: readonly SourceDoc[], draft: readonly SourceDoc[]): SourceDoc[] {
  const draftPaths = new Set(draft.map((document) => document.path));
  const activeByPath = new Map(active.map((document) => [document.path, document] as const));
  const moved = new Map<string, string>();
  for (const document of draft) {
    const before = activeByPath.get(document.path);
    if (before && before.text !== document.text) moved.set(digestOf(before.text), digestOf(document.text));
  }
  if (moved.size === 0) return [];
  const rewritten = new Map<string, SourceDoc>();
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const document of active) {
      if (draftPaths.has(document.path)) continue;
      const current = rewritten.get(document.path) ?? document;
      let text = current.text;
      for (const [from, to] of moved) text = text.split(from).join(to);
      if (text === current.text) continue;
      rewritten.set(document.path, { path: document.path, text });
      moved.set(digestOf(current.text), digestOf(text));
      changed = true;
    }
    if (!changed) break;
  }
  return [...rewritten.values()].sort((left, right) => left.path.localeCompare(right.path));
}
