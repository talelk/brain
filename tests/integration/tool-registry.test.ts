import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCatalogEntry } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello } from "../../apps/runner/src/supervisor";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

/** Issue #84: the registry reports facts the Governor holds, not invented ones. */
describe("tool registry read (issue #84)", () => {
  it("reports a stable activation time, allowed agents, proof and real usage; a tool with no calls reads never used", async () => {
    const root = mkdtempSync(join(tmp, "brain-tool-registry-"));
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const bundle = fixtureStarter();
      const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      w.brain.activateRelease(w.owner, release.digest);
      const read = async () => ((await w.brain.executeQuery(w.owner, { queryType: "tools.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: ToolCatalogEntry[] } }).snapshot.items;

      const first = await read();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await read();
      // createdAt is the activation of the release, so it does not move between reads.
      expect(second.map((tool) => tool.createdAt)).toEqual(first.map((tool) => tool.createdAt));
      const activated = w.brain.store.control.prepare("SELECT created_at_ms FROM events WHERE event_type='config.activated' AND aggregate_id=?").get(release.digest) as { created_at_ms: number };
      expect(new Date(first[0]!.createdAt).getTime()).toBe(activated.created_at_ms);

      const byId = new Map(first.map((tool) => [tool.id, tool]));
      expect([...byId.keys()].sort()).toEqual(["csv.query", "documents.read", "knowledge.search", "operations.context", "operations.validate", "task.validate", "web.fetch"]);
      expect(byId.get("documents.read")).toEqual(expect.objectContaining({ allowedAgents: ["task-worker"], status: "trusted", effectClass: "read", usage: { calls: 0, failures: 0 } }));
      expect(byId.get("operations.context")!.allowedAgents).toEqual(["operations-assistant"]);
      expect(byId.get("knowledge.search")!.allowedAgents).toEqual(["task-worker"]);
      expect(byId.get("task.validate")!.allowedAgents).toEqual([]);
      expect(byId.get("web.fetch")).toEqual(expect.objectContaining({ allowedHosts: expect.arrayContaining(["en.wikipedia.org"]), description: expect.stringContaining("plain GET") }));
      // Proof: the pinned script's own bytes and digest, not an empty list.
      const script = bundle.scripts!.find((entry) => entry.toolId === "documents.read")!;
      expect(byId.get("documents.read")!.evidence).toEqual([expect.objectContaining({ digest: sha256Digest(new Uint8Array(Buffer.from(script.bytesBase64, "base64"))), mediaType: "text/x-shellscript" })]);
      // The evidence row is readable: its artifact id resolves to the pinned script's bytes (it used to answer "artifact not found").
      expect(Buffer.from(w.brain.readArtifact(w.owner, byId.get("documents.read")!.evidence[0]!.artifactId)).toString("base64")).toBe(script.bytesBase64);
      expect(() => w.brain.readArtifact(w.owner, "tool-script:no.such.tool")).toThrow(/artifact not found/u);

      // Real tool events, posted through the runner protocol: two calls to documents.read (one failed) and one to csv.query.
      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir: join(root, "agents"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);
      await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-run", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "run", payload: { workflow: { id: "general-task", digest: release.digest }, input: { situation: "Compare two venues" } } } as never, "run");
      const offer = (await client.claim("claim-registry"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      const tool = (id: string) => ({ id, digest: byId.get(id)!.release.digest });
      let sequence = 0;
      const event = (kind: string, payload: Record<string, unknown>, at: string) => ({ sequence: ++sequence, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: `e${sequence}`, sessionId: "s", attemptId: offer.attemptId, sequence, occurredAt: at, kind, payload } });
      const proposed = (proposalId: string, id: string, at: string) => event("tool.proposed", { proposalId, tool: tool(id), input: {}, target: { targetId: `tool:${id}`, environmentId: "local", preconditionDigest: tool(id).digest }, inputDigest: sha256Digest(new TextEncoder().encode("{}")) }, at);
      const errorBytes = new TextEncoder().encode(JSON.stringify({ error: "document not found in this workspace. Use an id exactly as given in your context." }));
      const errorDigest = putBytes(w.brain.store, errorBytes);
      const result = (proposalId: string, outcome: "succeeded" | "failed", at: string) => event("tool.result", { proposalId, invocationId: proposalId, receipt: { invocationId: proposalId, attemptId: offer.attemptId, jobFence: offer.jobFence, result: outcome, startedAt: at, finishedAt: at, ...(outcome === "failed" ? { stdout: { artifactId: "att-err", digest: errorDigest, bytes: errorBytes.length, mediaType: "application/json", classification: "internal" } } : {}), effects: [] } }, at);
      await client.events(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, events: [
        proposed("p1", "documents.read", "2026-11-11T10:00:00.000Z"), result("p1", "succeeded", "2026-11-11T10:00:01.000Z"),
        proposed("p2", "documents.read", "2026-11-11T10:05:00.000Z"), result("p2", "failed", "2026-11-11T10:05:01.000Z"),
        proposed("p3", "csv.query", "2026-11-11T10:06:00.000Z"), result("p3", "succeeded", "2026-11-11T10:06:01.000Z"),
      ] });

      const used = new Map((await read()).map((entry) => [entry.id, entry]));
      const runId = offer.workflowRunId!;
      expect(used.get("documents.read")!.usage).toEqual({ calls: 2, failures: 1, lastCallAt: "2026-11-11T10:05:00.000Z", lastCallRunId: runId, lastFailureAt: "2026-11-11T10:05:01.000Z", lastFailureRunId: runId, lastFailureMessage: "document not found in this workspace. Use an id exactly as given in your context." });
      expect(used.get("csv.query")!.usage).toEqual({ calls: 1, failures: 0, lastCallAt: "2026-11-11T10:06:00.000Z", lastCallRunId: runId });
      // Counts come from the call table kept by event ingestion: a replayed batch (same sequences) counts nothing twice.
      await client.events(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, events: [
        proposed("p1", "documents.read", "2026-11-11T10:00:00.000Z"), result("p1", "succeeded", "2026-11-11T10:00:01.000Z"),
      ].map((entry, index) => ({ ...entry, sequence: index + 1 })) });
      expect(new Map((await read()).map((entry) => [entry.id, entry])).get("documents.read")!.usage).toMatchObject({ calls: 2, failures: 1 });
      expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 3 });
      // A tool nobody called still reads never used, and createdAt did not move.
      expect(used.get("web.fetch")!.usage).toEqual({ calls: 0, failures: 0 });
      expect(used.get("documents.read")!.createdAt).toBe(first[0]!.createdAt);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
