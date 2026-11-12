import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function serve(fetchFn: (r: Request) => Response | Promise<Response>): Promise<{ url: string }> {
  const server = createAdaptorServer({ fetch: fetchFn }) as import("node:http").Server;
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("trying a tool with an input (tagged test run)", () => {
  it("runs a read tool as a one-step test workflow on a real runner, records it apart from real calls, and refuses a write tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tool-test-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const bundle = fixtureStarter();
    const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
    w.brain.activateRelease(w.owner, release.digest);
    const listener = await serve(app.fetch);
    const cfg = { governorUrl: listener.url, runnerId: "tools-agents", stateDir: mkdtempSync(join(tmpdir(), "runner-tool-test-")), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);

    const { testId, runId } = w.brain.toolTests.run(w.owner, w.workspaceId, "operations.context", {});
    expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
    const tests = w.brain.toolTests.list(w.owner, w.workspaceId, "operations.context", 10);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ testId, runId, toolId: "operations.context", state: "succeeded" });
    expect(JSON.stringify(tests[0]!.output)).toContain("observations");
    // A test is tagged apart: it never reaches the call counts of the registry, and the run carries the tool-test workflow id.
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
    expect(w.brain.toolTests.isTestOf(w.org, runId, "operations.context")).toBe(true);
    expect(w.brain.toolTests.isTestOf(w.org, runId, "csv.query")).toBe(false);

    // A brokered read tool: the Governor supplies the document to a test that names exactly this tool, though no agent is involved.
    const upload = (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-note", commandType: "document.upload", workspaceId: w.workspaceId, idempotencyKey: "note",
      payload: { title: "notes.md", fileName: "notes.md", mediaType: "text/markdown", bytesBase64: Buffer.from("# Venue notes\nThe north hall seats two hundred people.\n").toString("base64") } } as never, "note")).receipt;
    const noteId = upload.resourceId!;
    w.brain.toolTests.run(w.owner, w.workspaceId, "documents.read", { documentId: noteId });
    expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
    const read = w.brain.toolTests.list(w.owner, w.workspaceId, "documents.read", 10)[0]!;
    expect(read.state, JSON.stringify(read)).toBe("succeeded");
    expect(JSON.stringify(read.output)).toContain("north hall");
    // The same request for a missing document fails in plain words, explained by the diagnosis.
    w.brain.toolTests.run(w.owner, w.workspaceId, "documents.read", { documentId: "doc-nope" });
    expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
    const missing = w.brain.toolTests.list(w.owner, w.workspaceId, "documents.read", 10)[0]!;
    expect(missing.state).toBe("failed");
    expect(missing.diagnosis?.cause).toBe("not-found");
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });

    expect(() => w.brain.toolTests.run(w.owner, w.workspaceId, "operations.context", [] as never)).toThrow(/JSON object/);
    expect(() => w.brain.toolTests.run(w.owner, w.workspaceId, "no.such.tool", {})).toThrow(/not in this release/);
  });
});
