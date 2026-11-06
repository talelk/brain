import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { Store } from "../../apps/governor/src/application/store";
import { casFilePath, putBytes, readVerified, sweepStorage, verifyStored } from "../../apps/governor/src/modules/artifacts/index";

// The artifacts module's byte storage against a bare Store in a temp
// directory: no Brain, no workspace, no HTTP.
let dir: string;
let store: Store;
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-artifacts-"));
  store = new Store({ dataDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("artifact store", () => {
  it("stores bytes once under their digest and reads them back verified", () => {
    const digest = putBytes(store, bytes("hello"));
    expect(digest).toBe(sha256Digest(bytes("hello")));
    const written = statSync(casFilePath(store, digest)).mtimeMs;
    expect(putBytes(store, bytes("hello"))).toBe(digest);
    expect(statSync(casFilePath(store, digest)).mtimeMs).toBe(written);
    expect(new TextDecoder().decode(readVerified(store, digest))).toBe("hello");
    expect(() => verifyStored(store, digest, 5)).not.toThrow();
  });

  it("reads changed, truncated or missing bytes as missing evidence, never as content", () => {
    const digest = putBytes(store, bytes("original"));
    writeFileSync(casFilePath(store, digest), "tampered");
    expect(() => readVerified(store, digest)).toThrow(/does not match/);
    expect(() => verifyStored(store, digest, 8)).toThrow(/missing or changed/);
    expect(() => putBytes(store, bytes("original"))).toThrow(/corrupted/);
    expect(() => readVerified(store, sha256Digest(bytes("never stored")))).toThrow(/is missing/);
    const sized = putBytes(store, bytes("sized"));
    expect(() => readVerified(store, sized, 4)).toThrow(/does not match/);
  });

  it("sweeps unreferenced files past the grace window and keeps referenced and recent ones", () => {
    const orphan = putBytes(store, bytes("orphan"));
    const recent = putBytes(store, bytes("recent"));
    const pinned = putBytes(store, bytes("release script"));
    store.control.prepare("INSERT INTO release_files(release_digest, tool_id, entrypoint, digest, bytes, created_at_ms) VALUES ('sha256:r','tool','run.sh',?,14,0)").run(pinned);
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const digest of [orphan, pinned]) utimesSync(casFilePath(store, digest), old, old);
    expect(sweepStorage(store)).toEqual({ scanned: 3, removed: 1, retained: 2 });
    expect(existsSync(casFilePath(store, orphan))).toBe(false);
    expect(existsSync(casFilePath(store, recent))).toBe(true);
    expect(existsSync(casFilePath(store, pinned))).toBe(true);
  });

  it("keeps the stored content of support drafts and memory publications", () => {
    store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-s','org-s')").run();
    store.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES ('ws-s','org-s','s','active')").run();
    const ws = store.workspaceDb("ws-s", "org-s");
    const draft = putBytes(store, bytes("draft reply"));
    const memory = putBytes(store, bytes("memory fact"));
    ws.pragma("foreign_keys = OFF");
    ws.prepare("INSERT INTO support_drafts(id, ticket_id, version, content_digest, source_fingerprint, evidence_digest, author_principal_id, created_at_ms) VALUES ('d1','t1',1,?,'f','e','p',0)").run(draft);
    ws.pragma("foreign_keys = ON");
    ws.prepare("INSERT INTO memory_publications(id, content_digest, target_scope_json, state, created_at_ms) VALUES ('m1',?,'{}','candidate',0)").run(memory);
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const digest of [draft, memory]) utimesSync(casFilePath(store, digest), old, old);
    expect(sweepStorage(store)).toMatchObject({ removed: 0 });
    expect(existsSync(casFilePath(store, draft))).toBe(true);
    expect(existsSync(casFilePath(store, memory))).toBe(true);
  });
});
