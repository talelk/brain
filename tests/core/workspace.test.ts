import { sha256Digest, type SnapshotManifest } from "@brain/contracts";
import git from "isomorphic-git";
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArtifact } from "../../apps/governor/src/trust/artifacts";
import { createHarness, type Harness } from "./harness";

let harness: Harness;
let workspaceId: string;
let slug: string;
const dir = () => join(harness.dataDir, "workspaces", slug);
const log = () => git.log({ fs, dir: dir() });
const agentToml = 'description = "Writes release notes."\nengine = ["fixture"]\ntools = ["echo"]\n';

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId, slug } = await harness.createWorkspace({ name: "Release Notes" }));
});
afterAll(() => harness.close());

describe("workspace.create", () => {
  it("makes a git-committed folder from the chosen packs, with a generated brain.toml", async () => {
    expect(slug).toBe("release-notes");
    const commits = await log();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.commit.author).toMatchObject({ name: "Ada Admin", email: "ada@example.com" });
    expect(await git.listFiles({ fs, dir: dir(), ref: "HEAD" })).toEqual(["brain.toml"]);
    const brain = await harness.admin.query("file.read", { workspaceId, path: "brain.toml" });
    expect(brain.content).toContain('name = "Release Notes"');
    expect(brain.content).toContain('packs = [ "extra" ]');
  });

  it("gives it an active snapshot whose manifest is stored under its digest", async () => {
    const workspace = await harness.admin.query("workspace.get", { workspaceId });
    expect(workspace).toMatchObject({ slug, name: "Release Notes", status: "active", role: "admin", commit: (await log())[0]?.oid });
    expect(workspace.snapshot.packs).toEqual(["core", "extra"]);
    expect(Object.keys(workspace.snapshot.agents).sort()).toEqual(["checker", "reviewer", "worker"]);
    const stored = readArtifact(harness.governor.gov, workspace.snapshotDigest);
    expect(sha256Digest(stored)).toBe(workspace.snapshotDigest);
    expect((JSON.parse(new TextDecoder().decode(stored)) as SnapshotManifest).name).toBe("Release Notes");
    // The prompt the manifest names is stored too: a result can be traced to the exact text an agent was given.
    expect(new TextDecoder().decode(readArtifact(harness.governor.gov, workspace.snapshot.agents["checker"]?.prompt.digest ?? ""))).toBe("You check results.\n");
  });

  it("lists the folder with its packs' files, and reads a pack file", async () => {
    const { files } = await harness.admin.query("workspace.files", { workspaceId });
    expect(files.find((file) => file.path === "brain.toml")).toMatchObject({ source: "workspace" });
    expect(files.find((file) => file.path === "agents/worker/prompt.md")).toMatchObject({ source: "extra" });
    expect(files.find((file) => file.path === "tools/echo/run.sh")).toMatchObject({ source: "core" });
    expect((await harness.admin.query("file.read", { workspaceId, path: "agents/reviewer/prompt.md" })).content).toBe("You review changes.\n");
    await expect(harness.admin.query("file.read", { workspaceId, path: "agents/nobody/prompt.md" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores a first model and project with their secrets by reference", async () => {
    const made = await harness.createWorkspace({
      name: "With a project", packs: ["core"],
      model: { provider: "openai-compatible", url: "https://models.example/v1", model: "qwen3-coder", key: "sk-model-key-value" },
      project: { repo: "https://github.com/example/shop.git", access: "write", credential: "ghp-credential-value" },
    });
    const { snapshot } = await harness.admin.query("workspace.get", { workspaceId: made.workspaceId });
    expect(snapshot.models).toEqual([{ name: "main", provider: "openai-compatible", url: "https://models.example/v1", model: "qwen3-coder", key: "secret:model-main" }]);
    expect(snapshot.projects).toMatchObject([{ name: "shop", branch: "main", access: "write", credential: "secret:github" }]);
    expect(snapshot.github).toEqual({ credential: "secret:github" });
    expect(await harness.admin.query("secrets.list", { workspaceId: made.workspaceId })).toMatchObject({ secrets: [{ name: "github" }, { name: "model-main" }], missing: [] });
  });

  it("refuses an address that is taken and a pack that does not exist, leaving nothing behind", async () => {
    await expect(harness.createWorkspace({ name: "Release Notes" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "Ghost", packs: ["nowhere"] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE", problems: [{ path: "brain.toml", message: 'pack "nowhere" does not exist' }] });
    expect(fs.existsSync(join(harness.dataDir, "workspaces", "ghost"))).toBe(false);
    expect((await harness.admin.query("me", {})).workspaces.map((workspace) => workspace.slug)).not.toContain("ghost");
  });

  it("lists the packs to choose from", async () => {
    const { packs } = await harness.admin.query("packs.list", {});
    expect(packs.map((pack) => pack.name)).toEqual(["core", "extra"]);
    expect(packs[1]).toMatchObject({ requires: ["core"], agents: [{ name: "reviewer", description: "Reviews a change." }], plays: [{ name: "review", title: "Change and review" }] });
    expect(packs[0]?.tools).toEqual([{ name: "echo", description: "Returns what it is given.", effect: "read" }, { name: "task.note", description: "Writes a note on the shared board.", effect: "read" }]);
  });
});

describe("file.write and file.delete", () => {
  it("commit as the person who wrote, and activate the new snapshot", async () => {
    const before = await harness.admin.query("workspace.get", { workspaceId });
    const written = await harness.admin.command("file.write", {
      workspaceId, message: "Add the writer",
      files: [{ path: "agents/writer/agent.toml", content: agentToml }, { path: "agents/writer/prompt.md", content: "Write the release notes." }],
    });
    const commits = await log();
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ oid: written.commit, commit: { message: "Add the writer\n", author: { name: "Ada Admin", email: "ada@example.com" } } });
    const after = await harness.admin.query("workspace.get", { workspaceId });
    expect(after.snapshotDigest).toBe(written.snapshotDigest);
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
    expect(after.commit).toBe(written.commit);
    expect(after.snapshot.agents["writer"]).toMatchObject({ source: "workspace", tools: ["echo"] });
    // The earlier snapshot is still there for work that was created on it.
    expect(JSON.parse(new TextDecoder().decode(readArtifact(harness.governor.gov, before.snapshotDigest)))).not.toHaveProperty("agents.writer");
  });

  it("refuse an invalid folder with the path and message of each problem, and change nothing", async () => {
    const before = await harness.admin.query("workspace.get", { workspaceId });
    const commits = (await log()).length;
    await expect(harness.admin.command("file.write", {
      workspaceId,
      files: [{ path: "agents/writer/agent.toml", content: agentToml.replace("echo", "deploy.restart") }, { path: "plays/notes.toml", content: 'title = "Notes"\n[[step]]\nid = "write"\nagent = "ghost"\n' }],
    })).rejects.toMatchObject({
      code: "INVALID_WORKSPACE",
      problems: [{ path: "agents/writer/agent.toml", message: 'tool "deploy.restart" does not exist' }, { path: "plays/notes.toml", message: 'step "write": agent "ghost" does not exist' }],
    });
    await expect(harness.admin.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: "name = 42\n" }] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE", problems: [{ path: "brain.toml" }] });
    expect((await log()).length).toBe(commits);
    expect(fs.existsSync(join(dir(), "plays/notes.toml"))).toBe(false);
    expect((await harness.admin.query("file.read", { workspaceId, path: "agents/writer/agent.toml" })).content).toBe(agentToml);
    expect((await harness.admin.query("workspace.get", { workspaceId })).snapshotDigest).toBe(before.snapshotDigest);
  });

  it("refuse a path under agents/ that Brain does not read, and a path outside the folder", async () => {
    for (const path of ["agents/writer/notes.txt", "../outside.toml", "agents/writer/../../brain.toml", "/etc/passwd"]) {
      await expect(harness.admin.command("file.write", { workspaceId, files: [{ path, content: "x" }] })).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ path }] });
    }
  });

  it("a workspace file replaces a pack file, and deleting it brings the pack file back", async () => {
    await harness.admin.command("file.write", { workspaceId, files: [{ path: "agents/reviewer/prompt.md", content: "Review strictly." }] });
    expect(await harness.admin.query("file.read", { workspaceId, path: "agents/reviewer/prompt.md" })).toMatchObject({ content: "Review strictly.", source: "workspace", replaces: "extra" });
    const deleted = await harness.admin.command("file.delete", { workspaceId, paths: ["agents/reviewer/prompt.md"] });
    expect(await harness.admin.query("file.read", { workspaceId, path: "agents/reviewer/prompt.md" })).toMatchObject({ content: "You review changes.\n", source: "extra" });
    expect((await log())[0]?.oid).toBe(deleted.commit);
    await expect(harness.admin.command("file.delete", { workspaceId, paths: ["agents/reviewer/prompt.md"] })).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ path: "agents/reviewer/prompt.md" }] });
    // Deleting half of an agent would leave the folder invalid.
    await expect(harness.admin.command("file.delete", { workspaceId, paths: ["agents/writer/prompt.md"] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
  });

  it("a command repeated with its idempotency key answers the same and commits once", async () => {
    const input = { workspaceId, files: [{ path: "memory/style.md", content: "# Style\n\nShort sentences.\n" }] };
    const first = await harness.admin.command("file.write", input, "write-style-1");
    const commits = (await log()).length;
    expect(await harness.admin.command("file.write", input, "write-style-1")).toEqual(first);
    expect((await log()).length).toBe(commits);
    await expect(harness.admin.command("file.write", { ...input, files: [{ path: "memory/style.md", content: "# Style\n\nOther.\n" }] }, "write-style-1")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await harness.admin.query("workspace.get", { workspaceId })).snapshot.memory.map((entry) => entry.name)).toEqual(["style", "welcome"]);
  });

  it("a folder committed just before a stop is activated at the next start", async () => {
    const before = await harness.admin.query("workspace.get", { workspaceId });
    fs.writeFileSync(join(dir(), "memory/late.md"), "# Late\n\nCommitted, not yet activated.\n");
    await git.add({ fs, dir: dir(), filepath: "memory/late.md" });
    const commit = await git.commit({ fs, dir: dir(), message: "Late", author: { name: "Ada Admin", email: "ada@example.com" } });
    expect((await harness.admin.query("workspace.get", { workspaceId })).snapshotDigest).toBe(before.snapshotDigest);
    await harness.restart();
    const after = await harness.admin.query("workspace.get", { workspaceId });
    expect(after.commit).toBe(commit);
    expect(after.snapshot.memory.map((entry) => entry.name)).toContain("late");
  });

  it("an archived workspace can be read and no longer changed", async () => {
    const made = await harness.createWorkspace({ name: "To archive", packs: ["core"] });
    expect(await harness.admin.command("workspace.archive", { workspaceId: made.workspaceId })).toEqual({});
    expect((await harness.admin.query("workspace.get", { workspaceId: made.workspaceId })).status).toBe("archived");
    await expect(harness.admin.command("file.write", { workspaceId: made.workspaceId, files: [{ path: "memory/x.md", content: "# X\n" }] })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
