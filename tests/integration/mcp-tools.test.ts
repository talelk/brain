import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import { prepareMcpCall, type McpDeclaration } from "../../apps/runner/src/tools/mcp";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";
import type { LauncherClient } from "../../apps/runner/src/launcher-client";
import { mcpClientScript } from "../../apps/cli/src/mcp";
import { setupWorld } from "../helpers";
import { egressDouble, fakeMcpServer, listTools, mcpStarter, type FakeMcp } from "../support/mcp-world";

// External MCP tools under governance (ADR 0064, ticket #137). The server is a local fake; the sandbox is a double that runs the pinned
// client script with the egress proxy (real, with a grant per sandbox) as its only network.
const tmp = process.env["TMPDIR"] ?? "/tmp";
const scriptBytes = new TextEncoder().encode(mcpClientScript());
const toolId = "mcp.fake.search";

let server: FakeMcp;
let other: FakeMcp;
let net: Awaited<ReturnType<typeof egressDouble>>;
let root = "";
let pinnedDigest = "";
let pinnedListing: Awaited<ReturnType<typeof listTools>>;
beforeAll(async () => { server = await fakeMcpServer(); other = await fakeMcpServer(); net = await egressDouble(); root = mkdtempSync(join(tmp, "brain-mcp-tools-")); pinnedListing = await listTools(server.url); pinnedDigest = pinnedListing.toolListDigest; });
afterAll(async () => { await server.close(); await other.close(); await net.close(); rmSync(root, { recursive: true, force: true }); });
afterEach(() => { server.calls.length = 0; other.calls.length = 0; delete process.env["BRAIN_MCP_SECRETS_DIR"]; });

function declaration(overrides: Partial<McpDeclaration> = {}): McpDeclaration {
  return { url: server.url, tool: "search", toolListDigest: pinnedDigest, maxOutputBytes: 512, host: server.host, ...overrides };
}

/** A launcher double: records every sandbox request and runs the cached pinned script through the egress double. */
function launcherDouble(): { launcher: LauncherClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  let last: Record<string, unknown> = {};
  let toolsDir = "";
  const launcher = {
    createSandbox: async (input: Record<string, unknown>) => { created.push(input); last = input; toolsDir = String(input["toolsDir"]); return { sandboxId: "sb-mcp" }; },
    exec: async (_id: string, script: string, input: string) => net.run(last, script.replace(/^\/tools/u, toolsDir), input),
    stop: async () => ({ terminationConfirmed: true }),
  } as unknown as LauncherClient;
  return { launcher, created };
}

async function call(input: Record<string, unknown>, options: { decl?: McpDeclaration; egressHosts?: string[]; launcher?: LauncherClient | null; effectClass?: string; id?: string } = {}) {
  const decl = options.decl ?? declaration();
  const prepared = prepareMcpCall(decl, "ws-a", options.egressHosts ?? [server.host]);
  if (!prepared.ok) return { prepared } as const;
  const double = launcherDouble();
  const cfg = { stateDir: join(root, "state") } as unknown as RunnerConfig;
  const launcher = options.launcher === null ? undefined : options.launcher ?? double.launcher;
  const id = options.id ?? toolId;
  const result = await executeToolPayload({
    offer: { payload: { input, step: { uses: { type: "tool", release: { id } }, effectClass: options.effectClass ?? "read" } }, execution: { kind: "tool" }, workspaceId: "ws-a" },
    cfg, launcher, mcp: prepared.call, toolPins: { [id]: sha256Digest(scriptBytes) },
    fetchPinnedTool: async () => ({ entrypoint: "run.sh", bytes: scriptBytes }),
    // Every workspace host is allowed, yet the sandbox must get only the declared one.
    egressHosts: [server.host, other.host, "api.example.com"],
  });
  return { prepared, result, created: double.created } as const;
}

describe("an external MCP read tool runs in the sandbox, bounded, with only its own host", () => {
  it("returns the tool's text cut to the declared size, asks the server once, and grants the sandbox exactly the server host", async () => {
    server.answer = () => ({ text: "x".repeat(5000) });
    const done = await call({ query: "notes" });
    expect(done.result).toMatchObject({ ok: true });
    const output = (done.result as unknown as { output: { tool: string; text: string; truncated: boolean } }).output;
    expect(output.tool).toBe("search");
    expect(Buffer.byteLength(output.text)).toBe(512);
    expect(output.truncated).toBe(true);
    expect(server.calls).toEqual([{ name: "search", arguments: { query: "notes" }, authorization: undefined }]);
    // The workspace allowed three hosts; the call's sandbox got the declared one only, on the proxy's internal network.
    expect(done.created).toEqual([expect.objectContaining({ profile: "agent", network: "internal", egressHosts: [server.host] })]);
    expect(net.log.some((line) => line.includes(server.host))).toBe(true);
  });

  it("refuses to run when the host is not on the workspace's egress hosts (the owner vouches for hosts)", async () => {
    const done = await call({ query: "notes" }, { egressHosts: ["api.example.com"] });
    expect(done.prepared).toMatchObject({ ok: false, error: expect.stringContaining("not on this workspace's egress hosts") });
    expect(server.calls).toEqual([]);
  });

  it("fails closed without the launcher: the runner never connects to the server itself", async () => {
    const done = await call({ query: "notes" }, { launcher: null });
    expect(done.result).toEqual({ ok: false, output: { error: expect.stringContaining("only in the launcher's sandbox") } });
    expect(server.calls).toEqual([]);
  });
});

describe("a changed tool list is refused until it is registered again", () => {
  it("refuses at call time when the server's list drifted since registration, and never calls the tool", async () => {
    const pinned = declaration();
    server.tools = [...server.tools, { name: "delete_everything", description: "added later", inputSchema: { type: "object" } }];
    try {
      const done = await call({ query: "notes" }, { decl: pinned });
      expect(done.result).toMatchObject({ ok: false });
      expect(JSON.stringify((done.result as { output: unknown }).output)).toMatch(/tool list changed since it was registered/u);
      expect(server.calls).toEqual([]);
      // A description edit is drift too (it is what a model reads).
      server.tools = server.tools.slice(0, 2).map((tool) => ({ ...tool, description: `${tool.description} (now with new instructions)` }));
      expect(await call({ query: "notes" }, { decl: pinned })).toMatchObject({ result: { ok: false } });
      expect(server.calls).toEqual([]);
    } finally { server.tools = server.tools.filter((tool) => tool.name !== "delete_everything").map((tool) => ({ ...tool, description: tool.description!.replace(" (now with new instructions)", "") })); }
    // Restored, the same pinned declaration works again.
    expect((await call({ query: "notes" }, { decl: pinned })).result).toMatchObject({ ok: true });
  });
});

describe("header secrets are by reference and scrubbed from what comes back", () => {
  it("sends the secret to the server only, and the server echoing it back shows [redacted]", async () => {
    const secrets = join(root, "secrets");
    mkdirSync(join(secrets, "ws-a"), { recursive: true });
    writeFileSync(join(secrets, "ws-a", "mcp-token"), "tok-9f3a7c1e\n", { mode: 0o600 });
    chmodSync(join(secrets, "ws-a", "mcp-token"), 0o600);
    process.env["BRAIN_MCP_SECRETS_DIR"] = secrets;
    server.answer = (_name, _args) => ({ text: `the server saw Bearer tok-9f3a7c1e in your header` });
    const done = await call({ query: "notes" }, { decl: declaration({ headers: { Authorization: { secretRef: "mcp-token", prefix: "Bearer " } } }) });
    expect(server.calls[0]!.authorization).toBe("Bearer tok-9f3a7c1e");
    const text = JSON.stringify((done.result as { output: unknown }).output);
    expect(text).not.toContain("tok-9f3a7c1e");
    expect(text).toContain("[redacted]");
    // A header whose secret is not in the runner's store for this workspace never runs.
    const missing = prepareMcpCall(declaration({ headers: { Authorization: { secretRef: "other-token" } } }), "ws-a", [server.host]);
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("not available in workspace scope") });
  });
});

describe("egress outside the declared host is refused", () => {
  it("the proxy answers 403 for a host outside the sandbox's grant, even if the script is told another address", async () => {
    // A tampered stdin (the declared host is the grant, the URL points at a second local server): the proxy refuses; the second server hears nothing.
    const decl = declaration();
    const prepared = prepareMcpCall(decl, "ws-a", [server.host]);
    if (!prepared.ok) throw new Error(prepared.error);
    const { launcher } = launcherDouble();
    const stdinKey = { ...(prepared.call.stdinKey as Record<string, unknown>), url: other.url };
    const { sandboxId } = await launcher.createSandbox({ profile: "agent", requestId: "t", toolsDir: join(root, "t"), network: "internal", egressHosts: [server.host] } as never);
    mkdirSync(join(root, "t"), { recursive: true });
    writeFileSync(join(root, "t", "run.sh"), mcpClientScript(), { mode: 0o755 });
    const result = await launcher.exec(sandboxId, "/tools/run.sh", JSON.stringify({ arguments: { query: "x" }, mcp: stdinKey }), 10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/HTTP 403/u);
    expect(other.calls).toEqual([]);
    expect(net.log.some((line) => line.includes(other.host) && /403|refus|deny|denied/iu.test(line))).toBe(true);
  });

  it("the client refuses a redirect to another host", async () => {
    const decl = declaration({ url: `${server.url.replace("/mcp", "")}/redirect` });
    const prepared = prepareMcpCall(decl, "ws-a", [server.host]);
    if (!prepared.ok) throw new Error(prepared.error);
    // The server answers every POST to /redirect with a 302 pointing at the other server.
    server.redirectTo = other.url;
    const done = await call({ query: "x" }, { decl });
    expect(done.result).toMatchObject({ ok: false });
    expect(other.calls).toEqual([]);
  });
});

describe("compiling an external MCP tool", () => {
  async function stage(edit: (doc: Record<string, unknown> & { spec: Record<string, unknown> }) => void, classes: Record<string, string> = { search: "read" }): Promise<unknown> {
    const dir = mkdtempSync(join(tmp, "brain-mcp-compile-"));
    const app = await createApp({ dataDir: join(dir, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const { bundle, toolIds, digests } = mcpStarter(server, classes, { listing: pinnedListing });
      const doc = bundle.documents.find((candidate) => candidate.path === `config/${toolIds[0]}.yaml`)!;
      const parsed = JSON.parse(doc.text) as Record<string, unknown> & { spec: Record<string, unknown> };
      edit(parsed);
      const prior = digests[toolIds[0]!]!;
      doc.text = JSON.stringify(parsed, null, 2) + "\n";
      const next = sha256Digest(new TextEncoder().encode(doc.text));
      for (const other of bundle.documents) if (other !== doc) other.text = other.text.replaceAll(prior, next);
      const staged = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      return JSON.parse((w.brain.store.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(staged.digest) as { manifest_json: string }).manifest_json);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  }

  it("accepts a declared tool and pins the server, the tool, the tool-list digest and the host in the release", async () => {
    const release = await stage(() => undefined) as { manifest: { tools: Array<{ id: string; effectClass: string; allowedHosts?: string[]; mcp?: { tool: string; toolListDigest: string; host: string } }> } };
    const tool = release.manifest.tools.find((candidate) => candidate.id === toolId)!;
    expect(tool).toMatchObject({ effectClass: "read", allowedHosts: [server.host], mcp: { tool: "search", host: server.host, toolListDigest: pinnedDigest } });
  });

  it("refuses a tool with no declared effect class (none is assumed, and the server's hints are not authority)", async () => {
    await expect(stage((doc) => { delete doc.spec["effectClass"]; })).rejects.toThrow(/must declare its effect class/u);
    await expect(stage((doc) => { doc.spec["effectClass"] = "maybe"; })).rejects.toThrow(/must declare its effect class|effectClass/u);
  });

  it("refuses privileged (a privileged sandbox never has a network), a host it did not declare, a tool-list digest that is not one, and an unusable schema", async () => {
    await expect(stage((doc) => { doc.spec["effectClass"] = "privileged"; })).rejects.toThrow(/cannot be privileged/u);
    await expect(stage((doc) => { doc.spec["allowedHosts"] = ["elsewhere.example"]; })).rejects.toThrow(/reaches only its server host/u);
    await expect(stage((doc) => { (doc.spec["mcp"] as Record<string, unknown>)["toolListDigest"] = "trust-me"; })).rejects.toThrow(/toolListDigest/u);
    await expect(stage((doc) => { (doc.spec["mcp"] as Record<string, unknown>)["url"] = "http://user:pw@127.0.0.1:9/mcp"; })).rejects.toThrow(/credentials/u);
    await expect(stage((doc) => { (doc.spec["mcp"] as Record<string, unknown>)["headers"] = { Authorization: { secretRef: "../token" } }; })).rejects.toThrow(/secretRef/u);
  });
});
