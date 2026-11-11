import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandReceipt } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

describe("agent tool calls through the whole broker path (supervisor, Governor, pinned script)", () => {
  it("knowledge.search, documents.read, csv.query and web.fetch are proposed by the agent, brokered, recorded as tool events with receipts and counted in the registry", async () => {
    const root = mkdtempSync(join(tmp, "brain-read-tools-"));
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const bundle = fixtureStarter();
      const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      w.brain.activateRelease(w.owner, release.digest);
      const command = async (commandType: string, key: string, payload: Record<string, unknown>): Promise<CommandReceipt> => (await w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, payload,
      } as never, key)).receipt;
      const upload = async (key: string, mediaType: string, fileName: string, text: string) => (await command("document.upload", key, { title: fileName, fileName, mediaType, bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;
      const noteId = await upload("note", "text/markdown", "venue.md", "The north hall seats two hundred people and costs 4800 EUR.");
      const csvId = await upload("csv", "text/csv", "cities.csv", "city,pop\nOslo,700000\nBergen,285000\n");
      const csvArtifactId = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: csvId })) as unknown as { snapshot: { document: { currentVersionId: string } } }).snapshot.document.currentVersionId;
      // Knowledge of this workspace, and of another one that must never show up.
      w.brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "kb-venue", text: "Past offsites: the north hall was the best value venue for two hundred people." });
      w.brain.memory.publish({ organizationId: w.org, workspaceId: "ws-elsewhere", sourceId: "kb-secret", text: "Another workspace's north hall pricing, which this mission must not see." });

      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir: join(root, "agents"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const toolEvents = (attemptId: string) => (w.brain.store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>)
        .map((row) => (JSON.parse(row.event_json) as { payload: { kind?: string; payload: Record<string, unknown> } }).payload).filter((entry) => entry.kind === "tool.proposed" || entry.kind === "tool.result");

      async function call(key: string, id: string, input: Record<string, unknown>): Promise<{ result: string; output: Record<string, unknown> }> {
        await command("workflow.dispatch", key, { workflow: { id: "general-task", digest: release.digest }, input: { situation: `Look something up\nAcceptance criteria:\n1. Uses the tool\nFIXTURE_CALL_TOOL ${JSON.stringify({ id, input })}` } });
        expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
        const attempt = w.brain.store.control.prepare("SELECT id FROM job_attempts ORDER BY rowid DESC LIMIT 1").get() as { id: string };
        const seen = toolEvents(attempt.id);
        expect(seen.map((entry) => entry.kind)).toEqual(["tool.proposed", "tool.result"]);
        const receipt = (seen[1]!.payload as unknown as { receipt: { result: string; stdout: { digest: string } } }).receipt;
        const output = JSON.parse(new TextDecoder().decode(readVerified(w.brain.store, receipt.stdout.digest))) as Record<string, unknown>;
        return { result: receipt.result, output };
      }

      const search = await call("k1", "knowledge.search", { query: "north hall" });
      expect(search.result).toBe("succeeded");
      const hits = (search.output as unknown as { results: Array<{ sourceId: string; status: string }> }).results;
      expect(hits.map((hit) => hit.sourceId)).toEqual(["kb-venue"]);
      expect(hits[0]!.status).toBe("unverified");
      expect(JSON.stringify(search.output)).not.toContain("must not see");

      const outside = await call("k2", "knowledge.search", { query: "north hall", workspaceId: "ws-elsewhere" });
      expect(outside.result).toBe("failed");
      expect(JSON.stringify(outside.output)).toContain("outside it");
      expect((w.brain.store.control.prepare("SELECT payload_json FROM events WHERE event_type='tool.read.refused' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string }).payload_json).toContain("knowledge.search");

      const doc = await call("d1", "documents.read", { documentId: noteId });
      expect(doc.result).toBe("succeeded");
      expect((doc.output as unknown as { text: string }).text).toContain("north hall seats two hundred");

      const table = await call("c1", "csv.query", { artifactId: csvArtifactId, sql: "SELECT city FROM data WHERE pop > 500000" });
      expect(table).toEqual({ result: "succeeded", output: expect.objectContaining({ rows: [["Oslo"]], columns: ["city"] }) });
      expect((await call("c2", "csv.query", { artifactId: csvArtifactId, sql: "DELETE FROM data" })).result).toBe("failed");

      const refusedHost = await call("f1", "web.fetch", { url: "https://evil.example.test/steal" });
      expect(refusedHost.result).toBe("failed");
      expect(JSON.stringify(refusedHost.output)).toContain("not on this tool's allowlist");

      // The calls are on the evidence bundles of their runs and in the registry's usage.
      const bundles = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT manifest_json FROM evidence_bundles").all() as Array<{ manifest_json: string }>).map((row) => JSON.parse(row.manifest_json) as { toolReleases: Array<{ id: string }> });
      expect(bundles.flatMap((entry) => entry.toolReleases.map((tool) => tool.id))).toEqual(expect.arrayContaining(["knowledge.search", "documents.read", "csv.query", "web.fetch"]));
      const registry = ((await w.brain.executeQuery(w.owner, { queryType: "tools.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Array<{ id: string; usage: { calls: number; failures: number } }> } }).snapshot.items;
      const usage = new Map(registry.map((tool) => [tool.id, tool.usage]));
      expect(usage.get("knowledge.search")).toEqual(expect.objectContaining({ calls: 2, failures: 1 }));
      expect(usage.get("csv.query")).toEqual(expect.objectContaining({ calls: 2, failures: 1 }));
      expect(usage.get("web.fetch")).toEqual(expect.objectContaining({ calls: 1, failures: 1 }));
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
