import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlobRef, SnapshotManifest } from "@brain/contracts";

/** What the folder of the workspace shows an agent: no file bigger than this, no more files than this, no more bytes than this in all. */
const MAX_FILE_BYTES = 128 * 1024;
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** A path from the workspace, kept inside the folder it is written to: no empty part, no `..`. */
const safe = (path: string): string => path.split("/").filter((part) => part !== "" && part !== "." && part !== "..").join("/");

/**
 * Writes the workspace as the attempt's snapshot holds it, for an agent that can read files: `manifest.json` (every agent, tool, Play, limit and
 * project as parsed), each agent's prompt, each tool's files, the memory entries and the documents, under `dir`. It is a copy to read, never
 * kept: nothing of it comes back, and no secret is in it (the snapshot names secrets, it never holds their values). Returns how many files it wrote.
 */
export async function placeWorkspaceFiles(client: { blob(ref: Pick<BlobRef, "digest"> & Partial<BlobRef>): Promise<Uint8Array> }, snapshotDigest: string, dir: string): Promise<number> {
  const raw = await client.blob({ digest: snapshotDigest as BlobRef["digest"] });
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as SnapshotManifest;
  const wanted: Array<{ path: string; digest: BlobRef["digest"]; bytes: number }> = [
    ...Object.entries(manifest.agents).map(([name, agent]) => ({ path: `agents/${name}/prompt.md`, digest: agent.prompt.digest, bytes: agent.prompt.bytes })),
    ...Object.entries(manifest.tools).flatMap(([name, tool]) => tool.files.map((file) => ({ path: `tools/${name}/${file.path}`, digest: file.digest, bytes: file.bytes }))),
    ...manifest.memory.map((entry) => ({ path: `memory/${entry.name}.md`, digest: entry.digest, bytes: entry.bytes })),
    ...manifest.documents.map((document) => ({ path: document.path, digest: document.digest, bytes: document.bytes })),
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), raw);
  let written = 1;
  let total = raw.length;
  for (const file of wanted) {
    const path = safe(file.path);
    if (path === "" || file.bytes > MAX_FILE_BYTES || written >= MAX_FILES || total + file.bytes > MAX_TOTAL_BYTES) continue;
    const bytes = await client.blob({ digest: file.digest });
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
    written += 1;
    total += bytes.length;
  }
  return written;
}
