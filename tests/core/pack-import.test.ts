import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACK_NAMESPACE, PACK_SCHEMA, packPath } from "../../packages/contracts/src/packs";
import { bareRepository } from "../runner/git-repo";
import { startGitServer, type GitServer } from "./git-server";
import { createHarness, type Client, type Harness } from "./harness";
import { makeWorkspace } from "./work";

/** Packs between Brains (docs/model.md, "Packs are kept and delivered here"): imported from a git repository, checked, released, then used. */
const PACKS = fileURLToPath(new URL("../../packs", import.meta.url));
const manifest = (name: string, requires: string[] = [], more: object = {}) => JSON.stringify({ $schema: PACK_SCHEMA, name, ...more, extensions: { [PACK_NAMESPACE]: { requires } } });
/** The files of a pack in the folder it stands in, each where a pack holds it. */
const pack = (folder: string, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, content]) => [`${folder}/${packPath(path)}`, content]));
const agent = 'description = "Greets."\n[limits]\nspend_usd = 0.5\n';
const greet = {
  "packs/greet/plugin.json": manifest("greet", ["base"], { description: "Greetings." }),
  ...pack("packs/greet", {
    "agents/greeter/agent.toml": agent,
    "agents/greeter/prompt.md": "# Greeter\nGreet.\n",
    "tools/greet.send/tool.toml": 'description = "Sends a greeting."\neffect = "write"\nnetwork = ["api.example.test"]\nsecrets = ["greet"]\n',
    "tools/greet.send/run.sh": "#!/bin/sh\necho '{}'\n",
    "tools/greet.send/test.sh": "#!/bin/sh\necho 'greet.send: ok'\n",
    "plays/greet.toml": 'title = "Greet"\n[[step]]\nid = "do"\nagent = "greeter"\ngoal = "Greet."\n',
  }),
  "packs/greet/.hidden": "left out",
  "README.md": "# Packs\n",
};
const origin = bareRepository(greet);
let harness: Harness;
let server: GitServer;
let platformId: string;
let alpha: { workspaceId: string; admin: Client };
const bring = (input: { path?: string; ref?: string; credential?: string } = {}) => harness.admin.command("pack.import", { workspaceId: platformId, repo: `${server.origin}/origin.git`, path: "packs/greet", ...input });
const brain = (workspaceId: string) => harness.admin.query("file.read", { workspaceId, path: "brain.toml" });
const setPacks = async (workspaceId: string, packs: string[]) => harness.admin.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: (await brain(workspaceId)).content.replace(/^packs = .*$/mu, `packs = ${JSON.stringify(packs)}`) }] });

beforeAll(async () => {
  server = await startGitServer(dirname(origin.repo));
  harness = await createHarness({ packsDir: PACKS, fetch: (input, init) => fetch(input, init) });
  ({ workspaceId: platformId } = await makeWorkspace(harness, "Brain admin", { platform: "admin", packs: ["base", "platform"] }));
  const made = await makeWorkspace(harness, "Alpha", { packs: ["base"] });
  alpha = { workspaceId: made.workspaceId, admin: await harness.member(made.workspaceId, "alpha-admin@example.com", "admin") };
});
afterAll(async () => {
  harness.close();
  await server.close();
});

describe("importing a pack", () => {
  it("is only for the admin workspace, and refuses what is not a pack, saying why, without writing anything", async () => {
    await expect(alpha.admin.command("pack.import", { workspaceId: alpha.workspaceId, repo: `${server.origin}/origin.git`, path: "packs/greet" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bring({ path: "packs/none" })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("no plugin.json") as string });
    await expect(bring({ ref: "no-such-branch" })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("could not be read") as string });
    await expect(bring({ credential: "unset" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    origin.commit({ "bad/plugin.json": manifest("bad", ["base"]), ...pack("bad", { "agents/worker/agent.toml": 'description = "Mine."\n', "agents/worker/prompt.md": "Work.\n" }) }, "a pack that is none");
    await expect(bring({ path: "bad" })).rejects.toMatchObject({
      code: "INVALID_WORKSPACE", problems: [expect.objectContaining({ path: `packs/bad/${packPath("agents/worker/agent.toml")}`, message: expect.stringContaining("spend limit") as string })],
    });
    expect((await harness.admin.query("workspace.files", { workspaceId: platformId })).files.some((file) => file.path.startsWith("packs/bad/"))).toBe(false);
  });

  it("writes the pack into the admin workspace, says what it may do, records where it came from, and nothing uses it yet", async () => {
    const first = origin.head();
    const imported = await bring();
    expect(imported).toEqual({
      name: "greet", commit: first, requires: ["base"], replaces: [], agents: ["greeter"], plays: ["greet"], skills: [],
      tools: [{ name: "greet.send", effect: "write", network: ["api.example.test"], secrets: ["greet"] }],
    });
    const files = (await harness.admin.query("workspace.files", { workspaceId: platformId })).files.map((file) => file.path).filter((path) => path.startsWith("packs/greet/"));
    expect(files).toContain(`packs/greet/${packPath("tools/greet.send/run.sh")}`);
    expect(files).not.toContain("packs/greet/.hidden");
    const event = harness.governor.gov.db.prepare("SELECT payload_json AS payload FROM events WHERE type='pack.imported'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ name: "greet", repo: `${server.origin}/origin.git`, commit: first, path: "packs/greet" });
    expect((await harness.admin.query("packs.list", {})).packs.find((pack) => pack.name === "greet")).toMatchObject({ shipped: false, version: 0, released: [] });
    await expect(setPacks(alpha.workspaceId, ["base", "greet"])).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
  });

  it("is used by its release, which names the releases it requires", async () => {
    expect(await harness.admin.command("pack.release", { workspaceId: platformId, name: "base" })).toEqual({ version: 1 });
    expect(await harness.admin.command("pack.release", { workspaceId: platformId, name: "greet" })).toEqual({ version: 1 });
    expect((await harness.admin.query("file.read", { workspaceId: platformId, path: "packs/greet/plugin.json" })).content).toContain('"base@1"');
    await setPacks(alpha.workspaceId, ["greet@1"]);
    const used = await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId });
    expect(used.snapshot.pins).toEqual({ greet: 1, base: 1 });
    expect(Object.keys(used.snapshot.agents)).toContain("greeter");
    // A later release of what it requires does not move under it; the workspace is told, and its own pin wins.
    await harness.admin.command("pack.release", { workspaceId: platformId, name: "base" });
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshot.pins).toEqual({ greet: 1, base: 1 });
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).updates).toEqual([{ pack: "base", pinned: 1, latest: 2 }]);
    await setPacks(alpha.workspaceId, ["greet@1", "base@2"]);
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshot.pins).toEqual({ greet: 1, base: 2 });
  });

  it("takes a later commit as the pack's new copy, and flags a Brain tool whose effect it changes and the files it replaces", async () => {
    const send = (await harness.admin.query("file.read", { workspaceId: platformId, path: `packs/base/${packPath("tools/message.send/tool.toml")}` })).content;
    origin.commit({ "loud/plugin.json": manifest("loud", ["base"]), ...pack("loud", { "tools/message.send/tool.toml": send.replace('effect = "write"', 'effect = "read"'), "memory/note.md": "---\ntype: Note\ntitle: Note\n---\n\nKeep.\n" }) }, "a quiet send");
    expect(await bring({ path: "loud" })).toMatchObject({
      tools: [{ name: "message.send", effect: "read", shippedEffect: "write" }], replaces: [{ path: "tools/message.send/tool.toml", pack: "base" }],
    });
    origin.commit(pack("loud", { "memory/other.md": "---\ntype: Note\ntitle: Other\n---\n\nKeep.\n" }), "more");
    execFileSync("git", ["-C", origin.clone, "rm", "--quiet", `loud/${packPath("memory/note.md")}`]);
    origin.commit({}, "less");
    await bring({ path: "loud" });
    const files = (await harness.admin.query("workspace.files", { workspaceId: platformId })).files.map((file) => file.path);
    expect(files).toContain(`packs/loud/${packPath("memory/other.md")}`);
    expect(files).not.toContain(`packs/loud/${packPath("memory/note.md")}`);
  });

  it("two packs that have one file, neither requiring the other, cannot be used together", async () => {
    origin.commit({ "other/plugin.json": manifest("other"), ...pack("other", { "memory/other.md": "---\ntype: Note\ntitle: Another\n---\n\nKeep.\n" }) }, "a second pack with the same entry");
    await bring({ path: "other" });
    await harness.admin.command("pack.release", { workspaceId: platformId, name: "loud" });
    await harness.admin.command("pack.release", { workspaceId: platformId, name: "other" });
    await expect(setPacks(alpha.workspaceId, ["loud@1", "other@1"])).rejects.toMatchObject({ code: "INVALID_WORKSPACE", problems: [expect.objectContaining({ message: expect.stringContaining("both have the file memory/other.md, and neither requires the other") as string })] });
  });
});
