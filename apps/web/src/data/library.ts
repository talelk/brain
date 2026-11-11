import { query } from "./client";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** One truthful count per Library shelf, counted by the Governor (never from a paginated list). */
export interface LibrarySummary {
  /** Knowledge Brain wrote up, tool candidates and Play proposals that wait for a person. */
  awaitingReview: number;
  publishedKnowledge: number;
  documents: number;
  plays: number;
  tools: number;
}

export async function librarySummary(workspaceId: string, signal?: AbortSignal): Promise<Envelope<LibrarySummary>> {
  const response = await query<Envelope<LibrarySummary>>({ queryType: "library.summary", workspaceId }, signal);
  return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}

/** A saved document is searchable by agents once its text was read (extraction ready); a file type that cannot be read is stored but not searchable. */
export async function documentSearchable(workspaceId: string, documentId: string | undefined): Promise<boolean> {
  if (!documentId) return false;
  try {
    const response = await query<Envelope<{ versions: ReadonlyArray<{ extractionStatus: string }> }>>({ queryType: "documents.get", workspaceId, resourceId: documentId });
    return response.snapshot.versions.some((version) => version.extractionStatus === "ready");
  } catch { return false; }
}
