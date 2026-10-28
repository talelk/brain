import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { setupWorld } from "../helpers";

async function* chunksOf(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, Math.min(bytes.length, i + size));
}

describe("artifact uploads: streamed, digest-bound, owner-scoped (T27)", () => {
  it("streams a large upload to CAS without buffering it whole and reads it back", async () => {
    const w = setupWorld();
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    const digest = sha256Digest(bytes);
    const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
    const done = await w.brain.putUploadStream(w.owner, up.uploadId, chunksOf(bytes, 64 * 1024)) as unknown as { artifactId: string; digest: string; bytes: number };
    expect(done.digest).toBe(digest);
    expect(done.bytes).toBe(bytes.length);
    expect(Buffer.from(w.brain.readArtifact(w.owner, done.artifactId)).equals(Buffer.from(bytes))).toBe(true);
    w.brain.close();
  });

  it("aborts an oversize stream before completion and binds completion to the initiator", async () => {
    const w = setupWorld();
    const bytes = new TextEncoder().encode("small");
    const digest = sha256Digest(bytes);
    const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
    const other = w.actor("owner-1");
    const stranger = { ...other, actorId: "someone-else" };
    await expect(w.brain.putUploadStream(stranger, up.uploadId, chunksOf(bytes, 2))).rejects.toThrow();
    // The initiator can still complete after the rejected foreign attempt.
    const done = await w.brain.putUploadStream(w.owner, up.uploadId, chunksOf(bytes, 2)) as unknown as { artifactId: string };
    expect(done.artifactId).toBeTruthy();

    const up2 = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: 4 }) as unknown as { uploadId: string };
    await expect(w.brain.putUploadStream(w.owner, up2.uploadId, chunksOf(new Uint8Array(64), 8))).rejects.toThrow(/exceeds|size/);
    const row = w.brain.store.control.prepare("SELECT state FROM artifact_uploads WHERE id=?").get(up2.uploadId) as { state: string };
    expect(row.state).toBe("rejected");
    w.brain.close();
  });
});
