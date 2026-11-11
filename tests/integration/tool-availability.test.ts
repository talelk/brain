import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandReceipt, ToolCatalogEntry } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { ensureContextPack } from "../../apps/governor/src/modules/jobs/attempts";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

/**
 * Track AA. Live, 2026-11-11: documents.read failed 21 of 21 calls in a workspace with no documents (the model guessed ids), and every
 * failed call cost a model round trip. A read tool with nothing to read is now reported unavailable in the registry, named in the task's
 * context, and left out of the agent's tool list (`contextPack.unavailableTools`, honoured by the runner).
 */
const tmp = process.env["TMPDIR"] ?? "/tmp";

async function scenario(run: (ctx: { w: ReturnType<typeof setupWorld>; releaseDigest: string; upload: (key: string, mediaType: string, fileName: string, text: string) => Promise<string>; tools: () => Promise<Map<string, ToolCatalogEntry>>; packFor: (jobId: string) => { text: string; unavailableTools: Array<{ id: string; reason: string }> } }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmp, "brain-tool-availability-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  try {
    const w = setupWorld(app.brain);
    const bundle = fixtureStarter();
    const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
    w.brain.activateRelease(w.owner, release.digest);
    const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> => (await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
    } as never, key)).receipt;
    const missionId = (await command("mission.create", "m", { title: "Venues", intent: "Choose a venue", successCriteria: ["delivered"] })).resourceId!;
    const planId = (await command("plan.propose", "p", { missionId, origin: "manual", tasks: [{ id: "a", title: "Compare venues", criteria: ["compared"], dependsOn: [] }] })).resourceId!;
    await command("plan.confirm", "c", { planVersionId: planId }, (w.brain.missions.query(w.owner, "missions.get", w.workspaceId, missionId) as unknown as { version: number }).version);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const item = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
    const runId = "run-availability";
    db.prepare("INSERT OR IGNORE INTO execution_links(mission_id, work_item_id, run_id, job_id, attempt_id, session_id, created_at_ms) VALUES (?,?,?,?,?,?,?)").run(missionId, item.id, runId, null, null, null, w.brain.store.now());
    const control = w.brain.store.control;
    const packFor = (jobId: string) => {
      control.prepare("PRAGMA foreign_keys=OFF").run();
      control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, "dispatch", JSON.stringify({ step: { uses: { type: "agent", release: { id: "task-worker" } }, task: "Compare venues" } }));
      ensureContextPack(w.brain.store, (organizationId, workspaceId, input) => w.brain.sessions.contextPackForRun(organizationId, workspaceId, input), w.org,
        { id: jobId, workspace_id: w.workspaceId, workflow_run_id: runId, config_digest: release.digest });
      const payload = JSON.parse((control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string }).payload_json) as { contextPack?: { text: string; unavailableTools: Array<{ id: string; reason: string }> } };
      return payload.contextPack!;
    };
    const tools = async () => new Map(((await w.brain.executeQuery(w.owner, { queryType: "tools.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: ToolCatalogEntry[] } }).snapshot.items.map((tool) => [tool.id, tool]));
    const upload = async (key: string, mediaType: string, fileName: string, text: string) => (await command("document.upload", key, { title: fileName, fileName, mediaType, bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;
    await run({ w, releaseDigest: release.digest, upload, tools, packFor });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

describe("read tool availability (track AA)", () => {
  it("a workspace with no documents or CSV files never offers documents.read or csv.query, and says so in the registry and in the task's context", async () => {
    await scenario(async ({ tools, packFor }) => {
      const registry = await tools();
      expect(registry.get("documents.read")!.availability).toEqual({ available: false, reason: "no documents yet" });
      expect(registry.get("csv.query")!.availability).toEqual({ available: false, reason: "no CSV files yet" });
      expect(registry.get("knowledge.search")!.availability).toEqual({ available: true });
      expect(registry.get("web.fetch")!.availability).toEqual({ available: true });

      const pack = packFor("job-empty");
      // Regression: a task with no documents never receives documents.read (the runner drops these ids from the engine's tool list).
      expect(pack.unavailableTools.map((tool) => tool.id).sort()).toEqual(["csv.query", "documents.read"]);
      expect(pack.text).toContain("Not available for this task, do not call: ");
      expect(pack.text).toContain("documents.read (no documents yet)");
      expect(pack.text).toContain("csv.query (no CSV files yet)");
      expect(pack.text).not.toContain("documents.read opens these saved documents");
      // The model is told which hosts web.fetch can reach, so it stops trying others (17 of the 50 live failures were off-list hosts).
      expect(pack.text).toContain("web.fetch can only reach these hosts: en.wikipedia.org");
    });
  });

  it("a saved document is offered with its real id and title; csv.query stays off until a CSV file exists, then lists the file", async () => {
    await scenario(async ({ tools, packFor, upload }) => {
      const noteId = await upload("note", "text/markdown", "venue-notes.md", "# Venue notes\nThe north hall seats two hundred people.\n");
      const registry = await tools();
      expect(registry.get("documents.read")!.availability).toEqual({ available: true });
      expect(registry.get("csv.query")!.availability.available).toBe(false);

      const pack = packFor("job-with-doc");
      expect(pack.unavailableTools.map((tool) => tool.id)).toEqual(["csv.query"]);
      expect(pack.text).toContain(`- ${noteId}: venue-notes.md`);
      expect(pack.text).toContain("csv.query (no CSV files yet)");

      await upload("csv", "text/csv", "cities.csv", "city,pop\nOslo,700000\n");
      expect((await tools()).get("csv.query")!.availability).toEqual({ available: true });
      const later = packFor("job-with-csv");
      expect(later.unavailableTools).toEqual([]);
      expect(later.text).toContain("csv.query reads these CSV files");
      expect(later.text).not.toContain("Not available for this task");
    });
  });
});
