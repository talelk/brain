import { GovernorError } from "../../data/client";

/**
 * The one authorized artifact-content read for every preview surface (plan T61).
 * ArtifactContent used to fetch with a bare `fetch` scattered across call sites;
 * ArtifactView is now the single preview policy and every read goes through
 * this module: same-origin credentials, Governor error mapping and a byte bound
 * so a huge artifact can never be decoded into the DOM by accident.
 */

/** The readable-inline bound for text-like previews (markdown, JSON, CSV, code). */
export const TEXT_PREVIEW_LIMIT = 256 * 1024;
/** The inline-embed bound for images and PDFs; above it only download is offered. */
export const MEDIA_EMBED_LIMIT = 20 * 1024 * 1024;

export interface ArtifactContentRead {
  maxBytes: number;
  signal?: AbortSignal;
}

/** Read the artifact's bytes through the authorized content endpoint. */
export async function readArtifactBytes(artifactId: string, read: ArtifactContentRead): Promise<Uint8Array> {
  const response = await fetch(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`, {
    credentials: "same-origin",
    headers: { accept: "application/octet-stream" },
    ...(read.signal ? { signal: read.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { detail?: string; message?: string; code?: string });
    throw new GovernorError(response.status, body.detail ?? body.message ?? `Artifact could not be read (${response.status})`, body.code);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > read.maxBytes)
    throw new Error(`The artifact is ${declared.toLocaleString("en-GB")} bytes; inline preview stops at ${read.maxBytes.toLocaleString("en-GB")}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > read.maxBytes)
    throw new Error(`The artifact is ${bytes.length.toLocaleString("en-GB")} bytes; inline preview stops at ${read.maxBytes.toLocaleString("en-GB")}.`);
  return bytes;
}

/** A short-lived embeddable URL for image/PDF previews; the caller revokes it. */
export function artifactObjectUrl(bytes: Uint8Array, mediaType: string): string {
  // The copy guarantees a standalone ArrayBuffer for the Blob (the input may be a view).
  return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType }));
}

/** Decode bytes as lossy UTF-8 text, clipped to the declared bound. */
export function decodeArtifactText(bytes: Uint8Array, maxBytes: number): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
}
