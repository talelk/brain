import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, EngineToolBinding } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello } from "../../apps/runner/src/supervisor";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { brokerRead } from "../../apps/runner/src/tools/broker-read";
import { isPublicAddress, webFetch } from "../../apps/runner/src/tools/brokers";
import { putBytes, registerArtifact } from "../../apps/governor/src/modules/artifacts/index";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

describe("shipped read tools: pinned scripts", () => {
  for (const tool of ["documents.read", "web.fetch", "csv.query"]) {
    it(`${tool} passes its own test.sh (bounds, read-only SQL, no side effects)`, () => {
      const run = spawnSync("bash", [`examples/v1/starter-release/tools/${tool}/test.sh`], { encoding: "utf8" });
      expect(run.status, run.stderr + run.stdout).toBe(0);
    });
  }
});

describe("web.fetch broker (GET only, host allowlist, bounds)", () => {
  const servers: Server[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.closeAllConnections(); });
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ host: string; base: string }> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { host, base: `http://${host}` };
  }
  const local = { allowPrivateNetwork: true } as const;

  it("fetches an allowlisted page and reports the address it came from", async () => {
    const site = await serve((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<h1>Hello</h1>"); });
    const result = await webFetch({ url: `${site.base}/page` }, [site.host], local);
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ url: `${site.base}/page`, status: 200, contentType: "text/html; charset=utf-8", body: "<h1>Hello</h1>", truncated: false }) });
  });

  it("refuses hosts outside the allowlist, non-GET, bad schemes, credentials and an empty allowlist", async () => {
    const site = await serve((_req, res) => res.end("secret"));
    expect(await webFetch({ url: `${site.base}/x` }, ["example.test"], local)).toEqual({ ok: false, error: expect.stringContaining("not on this tool's allowlist") });
    expect(await webFetch({ url: `${site.base}/x`, method: "POST" }, [site.host], local)).toEqual({ ok: false, error: "web.fetch performs GET requests only" });
    expect(await webFetch({ url: "file:///etc/passwd" }, [site.host], local)).toEqual({ ok: false, error: expect.stringContaining("only http and https") });
    expect(await webFetch({ url: `http://user:pw@${site.host}/` }, [site.host], local)).toEqual({ ok: false, error: expect.stringContaining("credentials") });
    expect(await webFetch({ url: `${site.base}/x` }, [], local)).toEqual({ ok: false, error: expect.stringContaining("no approved hosts") });
    expect(await webFetch({ url: "not a url" }, [site.host], local)).toEqual({ ok: false, error: "url is not a valid address" });
  });

  it("refuses loopback, private and metadata addresses even when the host is allowlisted", async () => {
    const site = await serve((_req, res) => res.end("internal"));
    for (const [url, allowed] of [[`${site.base}/`, site.host], ["http://localhost:9/", "localhost:9"], ["http://169.254.169.254/latest", "169.254.169.254"], ["http://[::1]:9/", "[::1]:9"]] as const) {
      const result = await webFetch({ url }, [allowed]);
      expect(result.ok, url).toBe(false);
    }
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPublicAddress(address), address).toBe(false);
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPublicAddress(address), address).toBe(true);
  });

  it("re-checks the allowlist on every redirect and stops redirect chains", async () => {
    const other = await serve((_req, res) => res.end("other host"));
    const site = await serve((req, res) => {
      if (req.url === "/out") { res.statusCode = 302; res.setHeader("location", `${other.base}/`); res.end(); return; }
      if (req.url === "/in") { res.statusCode = 302; res.setHeader("location", "/ok"); res.end(); return; }
      if (req.url === "/loop") { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); return; }
      res.setHeader("content-type", "text/plain"); res.end("fine");
    });
    expect(await webFetch({ url: `${site.base}/out` }, [site.host], local)).toEqual({ ok: false, error: expect.stringContaining("redirect was refused") });
    expect(await webFetch({ url: `${site.base}/in` }, [site.host], local)).toEqual({ ok: true, data: expect.objectContaining({ finalUrl: `${site.base}/ok`, body: "fine" }) });
    expect(await webFetch({ url: `${site.base}/loop` }, [site.host], local)).toEqual({ ok: false, error: "too many redirects" });
  });

  it("caps bytes while streaming, refuses binary content and enforces the time bound", async () => {
    const site = await serve((req, res) => {
      if (req.url === "/big") { res.setHeader("content-type", "text/plain"); res.write("a".repeat(4096)); res.write("b".repeat(4096)); res.end("c".repeat(4096)); return; }
      if (req.url === "/bin") { res.setHeader("content-type", "application/octet-stream"); res.end("\u0000\u0001"); return; }
      // never answers
    });
    const big = await webFetch({ url: `${site.base}/big` }, [site.host], { ...local, maxBytes: 5000 });
    expect(big.ok && big.data && typeof big.data === "object" && !Array.isArray(big.data) ? [(big.data as { body: string }).body.length, (big.data as { truncated: boolean }).truncated] : big).toEqual([5000, true]);
    expect(await webFetch({ url: `${site.base}/bin` }, [site.host], local)).toEqual({ ok: false, error: expect.stringContaining("not readable text") });
    expect(await webFetch({ url: `${site.base}/slow` }, [site.host], { ...local, timeoutMs: 300 })).toEqual({ ok: false, error: expect.stringContaining("web.fetch failed") });
  });
});

describe("Governor-brokered read tools: documents.read and csv.query", () => {
  it("answers only a live attempt whose agent allows the exact tool, rechecks workspace scope and audits refusals", async () => {
    const root = mkdtempSync(join(tmp, "brain-read-tools-"));
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const bundle = fixtureStarter();
      const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      w.brain.activateRelease(w.owner, release.digest);
      const digestOf = (id: string) => sha256Digest(new TextEncoder().encode(bundle.documents.find((doc) => doc.path.endsWith(`${id}.yaml`))!.text));
      const command = async (commandType: string, key: string, payload: Record<string, unknown>): Promise<CommandReceipt> => (await w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, payload,
      } as never, key)).receipt;
      const upload = async (key: string, mediaType: string, fileName: string, text: string) => (await command("document.upload", key, { title: fileName, fileName, mediaType, bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;
      const noteId = await upload("note", "text/markdown", "notes.md", `# Venue notes\n${"The north hall seats two hundred people. ".repeat(40)}`);
      const csvDocumentId = await upload("csv", "text/csv", "cities.csv", "city,pop\nOslo,700000\nBergen,285000\n");
      const csvArtifactId = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: csvDocumentId })) as unknown as { snapshot: { document: { currentVersionId: string } } }).snapshot.document.currentVersionId;
      const pdfDocumentId = await upload("pdf", "application/octet-stream", "blob.bin", "binary-ish");
      const pdfArtifactId = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: pdfDocumentId })) as unknown as { snapshot: { document: { currentVersionId: string } } }).snapshot.document.currentVersionId;

      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir: join(root, "agents"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);

      // A task-worker attempt: its agent allows documents.read and csv.query at the pinned digests.
      await command("workflow.dispatch", "task", { workflow: { id: "general-task", digest: release.digest }, input: { situation: "Summarise the venue notes\nAcceptance criteria:\n1. Mentions capacity" } });
      const offer = (await client.claim("claim-task"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      const binding = (tool: string): EngineToolBinding => ({ release: { id: tool, digest: digestOf(tool) }, inputSchema: {}, effectClass: "read", target: { targetId: `tool:${tool}`, environmentId: "local", preconditionDigest: digestOf(tool) } });
      const refusals = () => (w.brain.store.control.prepare("SELECT payload_json FROM events WHERE event_type='tool.read.refused' ORDER BY rowid").all() as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as { toolId: string; reason: string });

      const read = await brokerRead(binding("documents.read"), { documentId: noteId, maxChars: 100 }, offer.attemptId, client);
      expect(read).toEqual({ ok: true, data: expect.objectContaining({ documentId: noteId, title: "notes.md", mediaType: "text/markdown", revision: 1, truncated: true }) });
      expect(((read as { data: { text: string } }).data.text).length).toBe(100);

      const csv = await brokerRead(binding("csv.query"), { artifactId: csvArtifactId, sql: "SELECT 1" }, offer.attemptId, client);
      expect(csv).toEqual({ ok: true, data: { artifactId: csvArtifactId, digest: expect.stringMatching(/^sha256:/), csv: "city,pop\nOslo,700000\nBergen,285000\n" } });

      // Refusals: unknown document, an artifact that is not text, an artifact id that does not exist, a context reference nobody stored.
      expect(await brokerRead(binding("documents.read"), { documentId: "doc-nope" }, offer.attemptId, client)).toEqual({ ok: false, error: "document not found in this workspace" });
      expect(await brokerRead(binding("csv.query"), { artifactId: pdfArtifactId, sql: "SELECT 1" }, offer.attemptId, client)).toEqual({ ok: false, error: expect.stringContaining("not readable by this tool") });
      expect(await brokerRead(binding("csv.query"), { artifactId: "art-elsewhere", sql: "SELECT 1" }, offer.attemptId, client)).toEqual({ ok: false, error: "artifact not found in this workspace" });
      expect(await brokerRead(binding("documents.read"), { documentId: `artifact:sha256:${"1".repeat(64)}` }, offer.attemptId, client)).toEqual({ ok: false, error: expect.stringContaining("no context reference") });

      // A stored context reference is readable through documents.read, so compaction by reference is reversible by the agent itself.
      const body = "The full text that compaction replaced by a pointer. ".repeat(10);
      const bytes = new TextEncoder().encode(body);
      const digest = sha256Digest(bytes);
      putBytes(w.brain.store, bytes);
      registerArtifact(w.brain.store, { artifactId: "ctxref-job-x-0123456789abcdef", organizationId: w.org, workspaceId: w.workspaceId, digest, bytes: bytes.length, mediaType: "text/plain", classification: "internal", owner: { kind: "job", id: offer.jobId } });
      expect(await brokerRead(binding("documents.read"), { documentId: `artifact:${digest}`, maxChars: 60 }, offer.attemptId, client)).toEqual({ ok: true, data: expect.objectContaining({ text: body.slice(0, 60), truncated: true }) });

      // Tools the agent does not list, at a wrong digest, or that are not brokered are refused before any data is touched.
      expect(await brokerRead({ ...binding("documents.read"), release: { id: "documents.read", digest: `sha256:${"2".repeat(64)}` } }, { documentId: noteId }, offer.attemptId, client)).toEqual({ ok: false, error: expect.stringContaining("does not allow documents.read at that digest") });
      expect(await brokerRead(binding("operations.context"), {}, offer.attemptId, client)).toBeUndefined();
      await expect(client.toolRead(offer.attemptId, { tool: { id: "operations.context", digest: digestOf("operations.context") }, input: {} })).rejects.toThrow(/not a Governor-brokered read tool/);
      // A revoked document is no longer readable.
      await command("document.delete", "revoke-note", { documentId: noteId, reason: "obsolete" });
      expect(await brokerRead(binding("documents.read"), { documentId: noteId }, offer.attemptId, client)).toEqual({ ok: false, error: "document has been revoked" });
      // Another runner's session cannot use this attempt.
      const other = new GovernorClient(cfg);
      other.setToken("not-a-session");
      await expect(other.toolRead(offer.attemptId, { tool: binding("documents.read").release, input: { documentId: noteId } })).rejects.toThrow();

      // Every refusal is on the audit trail, with the tool and the reason.
      const audited = refusals();
      expect(audited.length).toBeGreaterThanOrEqual(7);
      expect(audited.map((entry) => entry.toolId)).toEqual(expect.arrayContaining(["documents.read", "csv.query", "operations.context"]));
      expect(audited.some((entry) => entry.reason === "document has been revoked")).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a read from an attempt whose agent has no such tool", async () => {
    const root = mkdtempSync(join(tmp, "brain-read-tools-"));
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const bundle = fixtureStarter();
      const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      w.brain.activateRelease(w.owner, release.digest);
      const digestOf = (id: string) => sha256Digest(new TextEncoder().encode(bundle.documents.find((doc) => doc.path.endsWith(`${id}.yaml`))!.text));
      await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-ops", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "ops", payload: { workflow: { id: "operations-triage", digest: release.digest }, input: { situation: "Latency rose" } } } as never, "ops");
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir: join(root, "agents"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport: (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch };
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);
      const offer = (await client.claim("claim-ops"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      await expect(client.toolRead(offer.attemptId, { tool: { id: "documents.read", digest: digestOf("documents.read") }, input: { documentId: "doc-1" } })).rejects.toThrow(/does not allow documents.read/);
      expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='tool.read.refused'").get()).toEqual({ n: 1 });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
