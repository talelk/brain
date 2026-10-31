import { stringify } from "yaml";
import { assertConfinedDocPaths, parseRestrictedYaml, type SourceDoc } from "./compiler";

export function normalizeDocuments(documents: readonly SourceDoc[]): SourceDoc[] {
  assertConfinedDocPaths(documents);
  for (const document of documents) parseRestrictedYaml(document.text, document.path);
  return documents.map((document) => ({ path: document.path, text: document.text })).sort((left, right) => left.path.localeCompare(right.path));
}

export function workflowDocument(id: string, jobs: Record<string, unknown>): SourceDoc {
  const value = {
    apiVersion: "brain.keyrus/v1",
    kind: "Workflow",
    metadata: { id },
    spec: { jobs },
  };
  return { path: `workflows/${id}.yaml`, text: stringify(value) };
}

export function documentKind(document: SourceDoc): string {
  const value = parseRestrictedYaml(document.text, document.path);
  return String(value["kind"] ?? "");
}

export function documentId(document: SourceDoc): string {
  const value = parseRestrictedYaml(document.text, document.path);
  const metadata = value["metadata"] as { id?: string } | undefined;
  return String(metadata?.id ?? "");
}
