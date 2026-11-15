import type { ActorContext } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { command } from "./interrupted-session";

/**
 * A published knowledge entry learned from a closed mission, whose source document then got a newer version (#133): the document and
 * the fingerprint the entry was written against are seeded; the change itself goes through the document.revise command, so the
 * Governor, not the test, marks the entry stale. `key` keeps the ids apart when a screen seeds more than one.
 */
export async function seedStaleKnowledge(brain: Brain, actor: ActorContext, workspaceId: string, input: { key: string; missionId: string; title: string; content: string; documentTitle: string }): Promise<{ assetId: string; documentId: string }> {
  const text = "Vendor A charges 120 euros a seat per year; Vendor B charges 95 euros but needs a three-year term.";
  const documentId = (await command(brain, actor, workspaceId, "document.upload", `${input.key}-doc`, { title: input.documentTitle, fileName: "prices.md", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  const version = ws.prepare("SELECT v.digest FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?").get(documentId) as { digest: string };
  const now = brain.store.now();
  const assetId = `ka-${input.key}`;
  ws.prepare(`INSERT INTO knowledge_assets(id, signature, operation_id, state, classification, content, source_count, title, mission_id, source_fingerprints_json, created_at_ms, updated_at_ms)
    VALUES (?,?, 'mission-knowledge', 'published', 'internal', ?, 1, ?, ?, ?, ?, ?)`)
    .run(assetId, `sha256:${Buffer.from(input.key).toString("hex").padEnd(64, "0").slice(0, 64)}`, input.content, input.title, input.missionId,
      JSON.stringify([{ kind: "document", id: documentId, title: input.documentTitle, digest: version.digest }]), now, now);
  // Published knowledge is also in the search index, as publication leaves it.
  brain.memory.publish({ organizationId: actor.organizationId, workspaceId, sourceId: assetId, text: input.content, sourceType: "knowledge", status: "reviewed", title: input.title });
  const current = ws.prepare("SELECT version FROM documents WHERE id=?").get(documentId) as { version: number };
  await command(brain, actor, workspaceId, "document.revise", `${input.key}-revise`, { documentId, title: input.documentTitle, fileName: "prices.md", mediaType: "text/markdown", bytesBase64: Buffer.from(`${text} Vendor C joined in May at 101 euros.`).toString("base64") }, current.version);
  return { assetId, documentId };
}
