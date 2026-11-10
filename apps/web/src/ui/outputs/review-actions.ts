import type { WorkItem } from "@brain/contracts";
import type { AppContextValue } from "../app-context";
import { artifactsHistoryQuery } from "../../data/exec-outputs";
import type { ArtifactHistory, ArtifactRef } from "../../data/exec-outputs";
import { readArtifactBytes } from "./artifact-bytes";
import { fileNameOf } from "./output-files";

/**
 * The review and file actions every output surface shares (T61): one
 * implementation of Accept / Request changes (the existing
 * `workItem.transition` command), Save as knowledge (the existing
 * `document.upload` command fed the artifact's authorized bytes) and
 * Download. The single-file review bar and the explorer's bulk selection bar
 * both call these, so the moves cannot drift between surfaces.
 */

/** The newest evidence bundle that carries an independent "verified" verdict for this artifact. */
export function verifiedBundle(history: ArtifactHistory | undefined): string | undefined {
  return history?.history.find((version) => version.verification?.outcome === "verified")?.bundleDigest;
}

export interface MoveResult {
  accepted: boolean;
  detail: string;
}

/**
 * Move a work item in review to Done (on verified evidence), or send it back for changes: back to
 * In progress with the reason, then on to Ready so the next run (automatic, or the Start button) picks it up.
 */
export async function moveWorkItem(
  app: AppContextValue,
  item: WorkItem,
  move: { state: "done"; evidenceDigest: string } | { state: "in-progress"; reason: string },
): Promise<MoveResult> {
  try {
    if (move.state === "done") {
      const result = await app.run("workItem.transition", { workItemId: item.workItemId, state: "done", evidenceDigest: move.evidenceDigest }, { expectedVersion: item.version });
      return { accepted: result.accepted, detail: result.accepted ? "" : result.detail || "The move was refused" };
    }
    const back = await app.run("workItem.transition", { workItemId: item.workItemId, state: "in-progress", reason: move.reason }, { expectedVersion: item.version });
    if (!back.accepted) return { accepted: false, detail: back.detail || "The move was refused" };
    const ready = await app.run("workItem.transition", { workItemId: item.workItemId, state: "ready" }, { expectedVersion: item.version + 1 });
    return { accepted: ready.accepted, detail: ready.accepted ? "" : ready.detail || "It went back but could not be made ready" };
  } catch (failure) {
    return { accepted: false, detail: failure instanceof Error ? failure.message : "The move was refused" };
  }
}

/** Accept one work item from one of its artifacts: resolves the verified evidence, then moves to Done. */
export async function acceptFromArtifact(app: AppContextValue, item: WorkItem, artifactId: string): Promise<MoveResult> {
  try {
    const history = await artifactsHistoryQuery({ artifactId });
    const evidence = verifiedBundle(history.snapshot);
    if (!evidence) return { accepted: false, detail: "No independent check has verified it yet." };
    const moved = await moveWorkItem(app, item, { state: "done", evidenceDigest: evidence });
    // Work others depend on needs a handoff first; that step lives on the single file, not in bulk.
    if (!moved.accepted && /handoff/iu.test(moved.detail)) return { accepted: false, detail: "Other tasks wait on it. Open the file to hand off, then accept." };
    return moved;
  } catch (failure) {
    return { accepted: false, detail: failure instanceof Error ? failure.message : "Its evidence could not be read." };
  }
}

/** The knowledge library's document cap and accepted media types (anything else uploads as raw bytes). */
const KNOWLEDGE_MAX_BYTES = 8 * 1024 * 1024;
const KNOWLEDGE_MEDIA = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf"]);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

/** Copy an artifact into the workspace knowledge library as a new document. */
export async function saveAsKnowledge(app: AppContextValue, artifact: ArtifactRef, title?: string): Promise<MoveResult> {
  if (artifact.bytes > KNOWLEDGE_MAX_BYTES) return { accepted: false, detail: "It is larger than the 8 MB knowledge limit." };
  try {
    const bytes = await readArtifactBytes(artifact.artifactId, { maxBytes: KNOWLEDGE_MAX_BYTES });
    const base = artifact.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
    const result = await app.run("document.upload", {
      title: title ?? fileNameOf(artifact),
      fileName: fileNameOf(artifact),
      mediaType: KNOWLEDGE_MEDIA.has(base) ? base : "application/octet-stream",
      bytesBase64: toBase64(bytes),
    });
    return { accepted: result.accepted, detail: result.accepted ? "" : result.detail || "The library refused it" };
  } catch (failure) {
    return { accepted: false, detail: failure instanceof Error ? failure.message : "It could not be read." };
  }
}

/** Start the authorized download of each artifact under its file name. */
export function downloadArtifacts(artifacts: readonly ArtifactRef[]): void {
  for (const artifact of artifacts) {
    const anchor = document.createElement("a");
    anchor.href = `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`;
    anchor.download = fileNameOf(artifact);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
}
