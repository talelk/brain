import { documentId, documentKind } from "./serialize";
import type { SourceDoc } from "./compiler";

export interface DraftImpact {
  readonly changedDefinitions: Array<{ kind: string; id: string; path: string; change: "added" | "changed" | "removed" }>;
  readonly impactedReferences: Array<{ path: string; references: string[] }>;
  readonly revalidationRequired: boolean;
}

export function impactDocuments(active: readonly SourceDoc[], draft: readonly SourceDoc[]): DraftImpact {
  const before = new Map(active.map((document) => [`${documentKind(document)}:${documentId(document)}`, document] as const));
  const after = new Map(draft.map((document) => [`${documentKind(document)}:${documentId(document)}`, document] as const));
  const changedDefinitions: DraftImpact["changedDefinitions"] = [];
  for (const [key, document] of before) if (!after.has(key)) changedDefinitions.push({ kind: documentKind(document), id: documentId(document), path: document.path, change: "removed" });
  for (const [key, document] of after) {
    const prior = before.get(key);
    if (!prior) changedDefinitions.push({ kind: documentKind(document), id: documentId(document), path: document.path, change: "added" });
    else if (prior.text !== document.text) changedDefinitions.push({ kind: documentKind(document), id: documentId(document), path: document.path, change: "changed" });
  }
  const ids = changedDefinitions.map((entry) => entry.id).filter(Boolean);
  const impactedReferences: DraftImpact["impactedReferences"] = [];
  for (const document of [...active, ...draft]) {
    const references = ids.filter((id) => id !== documentId(document) && document.text.includes(id));
    if (references.length > 0 && !impactedReferences.some((entry) => entry.path === document.path) && !changedDefinitions.some((entry) => entry.path === document.path) ) {
      impactedReferences.push({ path: document.path, references });
    }
  }
  return { changedDefinitions, impactedReferences, revalidationRequired: changedDefinitions.length > 0 || impactedReferences.length > 0 };
}
