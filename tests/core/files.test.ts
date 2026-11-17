import git from "isomorphic-git";
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchMemory } from "../../apps/governor/src/memory/memory";
import { createHarness, type Client, type Harness } from "./harness";

/** Documents (docs/model.md): any other file of the workspace folder, committed with it, searchable when text under docs/, downloadable always. */
let harness: Harness;
let workspaceId: string;
let slug: string;
let viewer: Client;
let stranger: Client;
const dir = () => join(harness.dataDir, "workspaces", slug);
const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 255, 254]);
const write = (files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>, remove: string[] = []) => harness.admin.command("file.write", { workspaceId, files, remove, message: "Upload" });
const events = (type: string) => (harness.governor.gov.db.prepare("SELECT payload_json AS payload FROM events WHERE type=? AND workspace_id=? ORDER BY seq DESC LIMIT 1").get(type, workspaceId) as { payload: string } | undefined)?.payload ?? "";

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId, slug } = await harness.createWorkspace({ name: "Handbook" }));
  viewer = await harness.member(workspaceId, "vera@example.com", "viewer");
  const other = await harness.createWorkspace({ name: "Elsewhere" });
  stranger = await harness.member(other.workspaceId, "olga@example.com", "admin");
});
afterAll(() => harness.close());

describe("documents", () => {
  it("one upload of a text and a binary document is one commit and one audit entry; the bytes come back exact, only to members", async () => {
    const before = (await git.log({ fs, dir: dir() })).length;
    const done = await write([{ path: "docs/handbook.md", content: "# Onboarding handbook\n\nLaptops are collected on the first Monday.\n" }, { path: "docs/logo.png", content: b64(PNG), encoding: "base64" }]);
    const commits = await git.log({ fs, dir: dir() });
    expect(commits).toHaveLength(before + 1);
    expect(commits[0]?.oid).toBe(done.commit);
    expect(events("workspace.changed")).toContain("docs/logo.png");

    const png = await harness.admin.query("file.read", { workspaceId, path: "docs/logo.png" });
    expect(png).toMatchObject({ binary: true, content: "", bytes: PNG.length, lastCommit: { message: "Upload" } });
    expect(await viewer.query("file.read", { workspaceId, path: "docs/handbook.md" })).toMatchObject({ binary: false, content: expect.stringContaining("first Monday") });

    const download = await viewer.fetch(`/v1/workspaces/${workspaceId}/files/docs/logo.png`);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(PNG));
    const header = (name: string) => download.headers.get(name);
    expect([header("content-type"), header("content-disposition"), header("x-content-type-options"), header("content-security-policy")]).toEqual(["image/png", "attachment; filename*=UTF-8''logo.png", "nosniff", "sandbox"]);
    expect((await harness.anonymous.fetch(`/v1/workspaces/${workspaceId}/files/docs/logo.png`)).status).toBe(401);
    expect((await stranger.fetch(`/v1/workspaces/${workspaceId}/files/docs/logo.png`)).status).toBe(404);
  });

  it("only text documents under docs/ are searchable by agents, and a search says the result is a document", async () => {
    const found = searchMemory(harness.governor.gov.db, workspaceId, "laptops monday");
    expect(found).toEqual([{ name: "docs/handbook.md", title: "Onboarding handbook", text: expect.stringContaining("Laptops"), source: "document" }]);
    expect(searchMemory(harness.governor.gov.db, workspaceId, "PNG")).toEqual([]);
    await write([{ path: "notes/ideas.txt", content: "zeppelin" }]);
    expect(searchMemory(harness.governor.gov.db, workspaceId, "zeppelin")).toEqual([]);
    await write([{ path: "docs/handbook.md", content: "# Onboarding handbook\n\nBadges are printed on the first Monday.\n" }]);
    expect(searchMemory(harness.governor.gov.db, workspaceId, "laptops")).toEqual([]);
  });

  it("a rename is one commit; a delete is a commit that git can still read", async () => {
    const rename = await write([{ path: "docs/guide.md", content: "# Guide\n" }], ["docs/handbook.md"]);
    expect((await git.log({ fs, dir: dir() }))[0]?.oid).toBe(rename.commit);
    const paths = (await harness.admin.query("workspace.files", { workspaceId })).files.map((file) => file.path);
    expect(paths).toContain("docs/guide.md");
    expect(paths).not.toContain("docs/handbook.md");
    const removed = await harness.admin.command("file.delete", { workspaceId, paths: ["docs/guide.md"], message: "Remove the guide" });
    expect(await git.readBlob({ fs, dir: dir(), oid: rename.commit, filepath: "docs/guide.md" })).toBeTruthy();
    expect((await git.listFiles({ fs, dir: dir(), ref: removed.commit })).includes("docs/guide.md")).toBe(false);
    expect(events("workspace.changed")).toContain("docs/guide.md");
  });

  it("refuses paths that leave the folder, hidden names, and bytes sent as Brain's own files; nothing is written", async () => {
    const head = (await git.log({ fs, dir: dir() }))[0]?.oid;
    for (const path of ["../outside.md", "docs/../../x.md", "/etc/passwd", "docs//a.md", "docs\\a.md", ".git/config", "docs/.env", ".env", "docs/./a.md", "docs/\u0000a.md"]) {
      await expect(write([{ path, content: "x" }]), path).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(write([{ path: "docs/.gitkeep", content: "" }])).resolves.toBeTruthy();
    await expect(write([{ path: "agents/x/agent.toml", content: b64("x"), encoding: "base64" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(write([{ path: "agents/x/agnet.toml", content: "x" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(write([{ path: "docs", content: "x" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fs.existsSync(join(dir(), "..", "outside.md"))).toBe(false);
    expect((await git.log({ fs, dir: dir() }))[1]?.oid).toBe(head);
  });

  it("enforces the size limits on the server: 5 MB a file, 20 MB an upload", async () => {
    const mb = (n: number): string => b64(new Uint8Array(n * 1024 * 1024).fill(65));
    await expect(write([{ path: "docs/big.pdf", content: mb(6), encoding: "base64" }])).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ message: expect.any(String) }] });
    const five = Array.from({ length: 5 }, (_, index) => ({ path: `docs/part${index}.bin`, content: mb(5), encoding: "base64" as const }));
    await expect(write(five)).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ message: expect.stringContaining("20 MB") }] });
    await expect(write([{ path: "docs/five.bin", content: mb(5), encoding: "base64" }])).resolves.toBeTruthy();
    await expect(write([{ path: "docs/bad.bin", content: "not base64!", encoding: "base64" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("only an admin writes, deletes or removes; a viewer reads", async () => {
    await expect(viewer.command("file.write", { workspaceId, files: [{ path: "docs/v.md", content: "x" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.command("file.delete", { workspaceId, paths: ["docs/five.bin"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await viewer.query("workspace.files", { workspaceId })).files.length).toBeGreaterThan(1);
  });
});
