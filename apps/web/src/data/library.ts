import { query } from "./client";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** One truthful count per Library shelf, counted by the Governor (never from a paginated list). */
export interface LibrarySummary {
  /** What truly needs a person: write-ups no one has approved (a second reviewer, a secret), tool candidates and Play proposals. */
  awaitingReview: number;
  needsPerson: { writeups: number; tools: number; plays: number };
  /** Write-ups Brain published itself as self-reviewed; they never wait here, and Withdraw undoes each. */
  publishedAutomatically: number;
  publishedKnowledge: number;
  documents: number;
  plays: number;
  tools: number;
  /** Write-ups published in the last seven days, and how many of those Brain published itself. */
  learnedThisWeek: number;
  learnedAutomatically: number;
  /** The workspace setting: verified write-ups publish themselves (on unless turned off). */
  autoPublishKnowledge: boolean;
  /** Ready-made Plays Brain ships: how many are in the release, how many can be added now, and why the rest cannot. */
  starterPlays: { total: number; installed: number; installable: number; blocked: ReadonlyArray<{ playId: string; reason: string }> };
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
