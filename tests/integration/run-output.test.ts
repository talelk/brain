import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The starter release with files.write granted to the task worker (a release grants a tool by pinning its digest in the agent). */
function starterWithFilesWrite() {
  const bundle = fixtureStarter();
  const tool = bundle.documents.find((doc) => doc.path.endsWith("files.write.yaml"))!;
  const agent = bundle.documents.find((doc) => doc.path.endsWith("task-worker-agent.yaml"))!;
  const prior = sha256Digest(new TextEncoder().encode(agent.text));
  const value = JSON.parse(agent.text) as { spec: { tools: Array<{ id: string; digest: string }> } };
  value.spec.tools.push({ id: "files.write", digest: sha256Digest(new TextEncoder().encode(tool.text)) });
  agent.text = JSON.stringify(value, null, 2) + "\n";
  const next = sha256Digest(new TextEncoder().encode(agent.text));
  for (const doc of bundle.documents) doc.text = doc.text.replaceAll(prior, next);
  return bundle;
}

describe("files an agent writes are collected from the run's output folder as artifacts", () => {
  it("attaches the good files to the run's evidence, refuses the bad names, and leaves no folder behind", async () => {
    const root = mkdtempSync(join(tmp, "brain-run-output-e2e-")); roots.push(root);
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const bundle = starterWithFilesWrite();
      const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
      w.brain.activateRelease(w.owner, release.digest);
      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir: join(root, "agents"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const calls = [
        { id: "files.write", input: { name: "report.md", content: "# Quarterly report\nRevenue is up." } },
        { id: "files.write", input: { name: "tables/q3.csv", content: "region,revenue\nnorth,10\n" } },
        { id: "files.write", input: { name: "../../escape.md", content: "pwned" } },
        { id: "files.write", input: { name: "run.sh", content: "rm -rf /" } },
      ];
      const situation = ["Write the quarterly files", "Acceptance criteria:", "1. Produces the report", ...calls.map((call) => `FIXTURE_CALL_TOOL ${JSON.stringify(call)}`)].join("\n");
      await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-out", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "out", payload: { workflow: { id: "general-task", digest: release.digest }, input: { situation } } } as never, "out");
      expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);

      const attempt = w.brain.store.control.prepare("SELECT id FROM job_attempts ORDER BY rowid DESC LIMIT 1").get() as { id: string };
      const events = (w.brain.store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attempt.id) as Array<{ event_json: string }>).map((row) => (JSON.parse(row.event_json) as { payload: { kind?: string; phase?: string; payload?: Record<string, unknown>; files?: Array<{ name: string; artifact: { digest: string } }> } }).payload);
      const results = events.filter((entry) => entry.kind === "tool.result").map((entry) => (entry.payload as unknown as { receipt: { result: string } }).receipt.result);
      expect(results).toEqual(["succeeded", "succeeded", "failed", "failed"]);

      // Exactly the two good files were collected, with their bytes and media types, as artifacts of this attempt.
      const collected = events.find((entry) => entry.phase === "run-output-collected")!.files!;
      expect(collected.map((file) => file.name)).toEqual(["report.md", "tables/q3.csv"]);
      const report = "# Quarterly report\nRevenue is up.";
      expect(collected[0]!.artifact.digest).toBe(sha256Digest(new TextEncoder().encode(report)));
      expect(new TextDecoder().decode(readVerified(w.brain.store, collected[0]!.artifact.digest))).toBe(report);
      expect(new TextDecoder().decode(readVerified(w.brain.store, collected[1]!.artifact.digest))).toBe("region,revenue\nnorth,10\n");
      // They are part of the immutable evidence of the run, so a result can point at them.
      const manifests = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT manifest_json FROM evidence_bundles").all() as Array<{ manifest_json: string }>).map((row) => JSON.parse(row.manifest_json) as { artifacts: Array<{ digest: string; mediaType: string }> });
      const attached = manifests.flatMap((manifest) => manifest.artifacts);
      expect(attached).toEqual(expect.arrayContaining([expect.objectContaining({ digest: collected[0]!.artifact.digest, mediaType: "text/markdown" }), expect.objectContaining({ digest: collected[1]!.artifact.digest, mediaType: "text/csv" })]));
      // Nothing was written outside the folder, and the folder is gone.
      expect(existsSync(join(root, "escape.md"))).toBe(false);
      expect(existsSync(join(root, "agents", "run-output", attempt.id))).toBe(false);
    } finally { await app.close(); }
  }, 120_000);
});
