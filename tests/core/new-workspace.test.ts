import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, tempDir, writeFiles } from "../runner/git-repo";
import { startGitServer, type GitServer } from "./git-server";
import { createHarness, type Harness } from "./harness";

/** What a person types to make a workspace (docs/model.md, "A workspace folder"): the address and project are inferred, the folder may have a remote. */
let harness: Harness;
let server: GitServer;
const root = tempDir("new-workspace");

/** A bare repository whose own default branch is `trunk`, with one commit, served over HTTP. */
function trunkRepository(): void {
  git(root, "init", "--quiet", "--bare", "--initial-branch=trunk", `${root}/shop.git`);
  git(root, "clone", "--quiet", `${root}/shop.git`, `${root}/shop`);
  git(`${root}/shop`, "checkout", "--quiet", "-b", "trunk");
  writeFiles(`${root}/shop`, { "README.md": "# Shop\n" });
  git(`${root}/shop`, "add", "--all");
  git(`${root}/shop`, "commit", "--quiet", "-m", "first");
  git(`${root}/shop`, "push", "--quiet", "origin", "HEAD:trunk");
}

beforeAll(async () => {
  trunkRepository();
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", `${root}/backup.git`);
  server = await startGitServer(dirname(`${root}/shop.git`));
  harness = await createHarness({ fetch: (input, init) => fetch(input, init) });
});
afterAll(async () => {
  harness.close();
  await server.close();
});

const settled = async (read: () => boolean | Promise<boolean>): Promise<void> => {
  for (let at = 0; at < 100; at += 1) { if (await read()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("it did not happen in time");
};
const pushes = (workspaceId: string): Array<{ type: string; payload: { message?: string; remote: string } }> =>
  (harness.governor.gov.db.prepare("SELECT type, payload_json AS payload FROM events WHERE workspace_id=? AND type LIKE 'workspace.push%' ORDER BY seq").all(workspaceId) as Array<{ type: string; payload: string }>).map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as { message?: string; remote: string } }));

describe("the address", () => {
  it("is made from the name, and a name that makes an address a workspace already has is refused, whatever the case or accents", async () => {
    expect(await harness.createWorkspace({ name: "Café Réseau" })).toMatchObject({ slug: "cafe-reseau" });
    for (const again of [{ name: "CAFE reseau" }, { name: "Another", slug: "Cafe-Reseau" }, { name: "Café  réseau!" }]) {
      await expect(harness.createWorkspace(again)).rejects.toMatchObject({ code: "CONFLICT", problems: [{ path: "name", message: expect.stringContaining("change the name") }] });
    }
    const made = await harness.createWorkspace({ name: "Old one" });
    await harness.admin.command("workspace.archive", { workspaceId: made.workspaceId });
    await expect(harness.createWorkspace({ name: "old ONE" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "!!!" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("the project", () => {
  it("is named from its address, and takes the branch the repository itself calls its default", async () => {
    const made = await harness.createWorkspace({ name: "Shop", project: { repo: `${server.origin}/shop.git`, access: "read" } });
    expect((await harness.admin.query("workspace.get", { workspaceId: made.workspaceId })).snapshot.projects).toMatchObject([{ name: "shop", branch: "trunk", access: "read" }]);
    const text = (await harness.admin.query("file.read", { workspaceId: made.workspaceId, path: "brain.toml" })).content;
    expect(text).not.toContain("access");
    expect(text).not.toContain("running_tasks");
  });

  it("falls back to main, quickly, when the repository cannot be asked", async () => {
    const started = Date.now();
    const made = await harness.createWorkspace({ name: "Nowhere", project: { repo: "http://127.0.0.1:9/acme/billing-api.git", access: "write" } });
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await harness.admin.query("workspace.get", { workspaceId: made.workspaceId })).snapshot.projects).toMatchObject([{ name: "billing-api", branch: "main", access: "write" }]);
  });
});

describe("the folder's remote", () => {
  it("receives the branch after the first commit and after every change, never by force", async () => {
    const made = await harness.createWorkspace({ name: "Backed up", folderRemote: `${server.origin}/backup.git` });
    await settled(() => pushes(made.workspaceId).length >= 1);
    expect(git(`${root}/backup.git`, "ls-tree", "-r", "--name-only", "main")).toBe("brain.toml");
    await harness.admin.command("file.write", { workspaceId: made.workspaceId, files: [{ path: "memory/note.md", content: "# Note\n" }] });
    await settled(() => git(`${root}/backup.git`, "ls-tree", "-r", "--name-only", "main").includes("memory/note.md"));
    expect(pushes(made.workspaceId).every((push) => push.type === "workspace.pushed")).toBe(true);
    const shown = (await harness.admin.query("workspace.get", { workspaceId: made.workspaceId })).folderPush;
    expect(shown).toMatchObject({ ok: true });
    expect((await harness.admin.query("health", { workspaceId: made.workspaceId })).folderPush).toMatchObject({ ok: true });
  });

  it("fails without failing the commit, and records the failure without a secret", async () => {
    const made = await harness.createWorkspace({ name: "Unreachable", folderRemote: "http://127.0.0.1:9/nobody/backup.git" });
    await harness.admin.command("secret.set", { workspaceId: made.workspaceId, name: "github", value: "tok-very-secret-value" });
    const changed = await harness.admin.command("file.write", { workspaceId: made.workspaceId, files: [{ path: "memory/note.md", content: "# Note\n" }] });
    expect(changed.commit).toMatch(/^[0-9a-f]{40}$/u);
    await settled(() => pushes(made.workspaceId).some((push) => push.type === "workspace.push_failed"));
    expect(JSON.stringify(pushes(made.workspaceId))).not.toContain("tok-very-secret-value");
    expect((await harness.admin.query("workspace.get", { workspaceId: made.workspaceId })).folderPush).toMatchObject({ ok: false, message: expect.any(String) });
    // A remote that is not a plain http(s) address is not valid at all.
    await expect(harness.admin.command("file.write", { workspaceId: made.workspaceId, files: [{ path: "brain.toml", content: 'name = "Unreachable"\n[git]\nremote = "/etc"\n' }] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
  });
});
