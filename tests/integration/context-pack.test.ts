import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandReceipt, JsonValue, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { contextBudget, ensureContextPack } from "../../apps/governor/src/modules/jobs/attempts";
import { ownBundleJob } from "../support/evidence";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";

/**
 * Issue #80: a workflow-driven agent step receives the Governor-built context
 * pack (brief constraints, accepted decisions, dependency handoff facts and
 * notes), the manifest is stored as an immutable artifact the job references,
 * and nothing outside the declared sections is injected.
 */
const tmp = process.env["TMPDIR"] ?? "/tmp";
const LONG_SUMMARY = `Option north hall wins on cost. ${"The north hall is cheaper than the harbour room and also closer to the station. ".repeat(24)}`.trim();

async function scenario(run: (ctx: { app: Awaited<ReturnType<typeof createApp>>; w: ReturnType<typeof setupWorld>; root: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmp, "brain-context-pack-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  try { await run({ app, w: setupWorld(app.brain), root }); } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

describe("context pack delivery (issue #80)", () => {
  it("gives a dependent task the brief constraints, decisions and its dependency's handoff, and stores the manifest", async () => {
    await scenario(async ({ app, w, root }) => {
      const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> => (await w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key,
        ...(expectedVersion ? { expectedVersion } : {}), payload,
      } as never, key)).receipt;
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);

      const bundle = fixtureStarter();
      const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
      const single = JSON.parse(source.text);
      single.metadata.id = "general-single";
      delete single.spec.jobs["validate"];
      single.spec.outputs["passed"] = { source: "literal", value: true };
      bundle.documents.push({ path: "config/general-single.yaml", text: JSON.stringify(single, null, 2) + "\n" });
      w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);

      const tasks: PlanTask[] = [
        { id: "a", title: "Task a", criteria: ["a is written up"], dependsOn: [], workflowId: "general-single" },
        { id: "b", title: "Task b", criteria: ["b is written up"], dependsOn: ["a"] },
      ];
      const missionId = (await command("mission.create", "m-create", { title: "venue", intent: "Choose a venue", successCriteria: ["delivered"] })).resourceId!;
      const missionVersion = () => ((w.brain.missions.query(w.owner, "missions.get", w.workspaceId, missionId)) as unknown as Mission).version;
      const briefVersion = () => (w.brain.missions.query(w.owner, "missions.brief", w.workspaceId, missionId) as unknown as { version: number }).version;
      await command("mission.brief.edit", "m-brief", { missionId, baseVersion: briefVersion(), constraints: ["Stay under 5000 EUR"] });
      await command("decision.accept", "m-decision", { missionId, baseVersion: briefVersion(), statement: "Use the north hall", source: { kind: "human" } });
      const planId = (await command("plan.propose", "m-plan", { missionId, origin: "manual", tasks })).resourceId!;
      await command("plan.confirm", "m-confirm", { planVersionId: planId }, missionVersion());

      const itemOf = (taskId: string): WorkItem => {
        const row = db.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=?").get(missionId, taskId) as { id: string };
        return w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, row.id) as unknown as WorkItem;
      };
      const runOf = (workItemId: string) => (db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=? ORDER BY created_at_ms DESC").get(workItemId) as { run_id: string }).run_id;
      const a = itemOf("a");
      const runA = runOf(a.workItemId);
      const until = async (done: () => boolean) => {
        const deadline = Date.now() + 20_000;
        while (!done()) { if (Date.now() > deadline) throw new Error("did not progress"); await new Promise((resolve) => setTimeout(resolve, 25)); }
      };

      // A finishes with an independently verified bundle, which gives B its handoff.
      const digest = `sha256:${"a".repeat(64)}`;
      const manifest = { contractVersion: "brain.evidence/v1", bundleId: "bundle-a", organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: "run-seed", jobId: "job-seed-a", attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [], checks: ["structure", "safety", "deliverable", "criteria-met"].map((id) => ({ criterionId: id, checkId: id, status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })), approvalIds: [], effects: [], createdAt: new Date().toISOString() };
      db.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, "bundle-a", "job-seed-a", "att-seed", JSON.stringify(manifest), w.brain.store.now());
      db.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run("verdict-a", digest, "eval-seed", DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
      ownBundleJob(db, a.workItemId, "job-seed-a", w.brain.store.now());
      await until(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runA)));
      w.brain.workflows.completeStep(w.org, w.workspaceId, runA, "respond", { summary: LONG_SUMMARY, deliverable: "# Task a", criteria: [], assumptions: [] } as unknown as JsonValue, true);
      await until(() => itemOf("a").state === "done");
      // A's job was completed by hand above; no runner should pick it up.
      w.brain.store.control.prepare("UPDATE jobs SET state='cancelled' WHERE workflow_run_id=?").run(runA);
      await until(() => itemOf("b").state === "in-progress");

      // Before any runner claims it, B's job carries no pack: the Governor builds it at the first offer.
      const runB = runOf(itemOf("b").workItemId);
      const jobB = w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runB) as { id: string };
      const payloadOf = () => JSON.parse((w.brain.store.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobB.id) as { payload_json: string }).payload_json) as { contextPack?: { text: string; manifestArtifact: { artifactId: string; digest: string }; estimatedTokens: number } };
      expect(payloadOf().contextPack).toBeUndefined();

      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const caps = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"];
      const cfg = (group: string) => ({ governorUrl: "http://127.0.0.1:3000", runnerId: `runner-${group}`, stateDir: join(root, group), capabilities: caps, engines: ["fixture"], transport });
      const author = cfg("agents"); const evaluator = cfg("evaluators");
      const authorSession = await enrollAndHello(author, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const evalSession = await enrollAndHello(evaluator, w.brain.jobProtocol.issueEnrollment(w.owner, "evaluators").token);
      expect(await runOnce(author, authorSession.sessionToken, authorSession.epoch)).toBe(true);
      expect(await runOnce(evaluator, evalSession.sessionToken, evalSession.epoch)).toBe(true);

      const pack = payloadOf().contextPack!;
      expect(pack).toBeDefined();
      // Brief constraints, the accepted decision, the dependency's verified facts, and its notes labelled as a claim.
      expect(pack.text).toContain("Goal: Choose a venue");
      expect(pack.text).toContain("- Stay under 5000 EUR");
      expect(pack.text).toContain("- Use the north hall");
      expect(pack.text).toMatch(/- Task a: \d+ of \d+ criteria passed; evidence sha256:/);
      // The brief the task itself receives already quotes the upstream summary, so the pack does not say it a second time.
      const situation = (JSON.parse((db.prepare("SELECT input_json FROM run_inputs WHERE run_id=?").get(runB) as { input_json: string }).input_json) as { situation: string }).situation;
      expect(situation).toContain("Option north hall wins on cost.");
      expect(pack.text).not.toContain("## Handoff notes from those tasks");
      expect(pack.text).not.toContain("Option north hall wins on cost.");
      // Nothing outside the declared sections is injected.
      const declared = ["Mission brief and this task's criteria", "Accepted decisions", "Verified results of the tasks this one builds on", "Handoff notes from those tasks (written by the member)", "Inputs pinned for this task (fetch by reference)", "Messages sent to this task", "Where earlier work on this task stopped", "The previous attempt failed"];
      const headings = [...pack.text.matchAll(/^## (.+?) \[[^\]]+\]$/gm)].map((match) => match[1]);
      expect(headings.length).toBeGreaterThan(2);
      for (const heading of headings) expect(declared).toContain(heading);

      // The manifest is an immutable artifact the job references; its estimate is labelled and its text digest matches the pack.
      const stored = JSON.parse(new TextDecoder().decode(readVerified(w.brain.store, pack.manifestArtifact.digest))) as { estimatedTokens: number; estimateNote: string; textDigest: string; jobId: string; runId: string; sections: Array<{ id: string }> };
      expect(stored.textDigest).toBe(sha256Digest(new TextEncoder().encode(pack.text)));
      expect(stored.estimateNote).toMatch(/Estimated/);
      expect(stored.estimatedTokens).toBe(pack.estimatedTokens);
      expect([stored.jobId, stored.runId]).toEqual([jobB.id, runB]);
      expect(stored.sections.map((section) => section.id)).toEqual(expect.arrayContaining(["brief", "decisions", "handoff-facts"]));
      expect(w.brain.store.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=?").get(`ctx-${jobB.id}`)).toEqual({ digest: pack.manifestArtifact.digest });
      // The run completed with the pack in front of the task (the fixture engine still parsed the task after it).
      await until(() => (db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runB) as { state: string }).state === "succeeded");
      // The pinned execution artifact, not a recomputation, is what a repeat claim would see.
      expect(payloadOf().contextPack!.text).toBe(pack.text);
      // Over a tiny budget, for a task whose brief does not carry the upstream summary, the same sources compact by reference: the manifest is stored, the full text stays fetchable.
      const control = w.brain.store.control;
      control.prepare("DELETE FROM artifact_associations WHERE artifact_id LIKE ? OR artifact_id=?").run(`ctx%-${jobB.id}%`, `exec-${jobB.id}`);
      control.prepare("UPDATE job_payloads SET payload_json=? WHERE job_id=?").run(JSON.stringify({ ...payloadOf(), contextPack: undefined, input: { situation: "Task b" } }), jobB.id);
      ensureContextPack(w.brain.store, (organizationId, workspaceId, input) => w.brain.sessions.contextPackForRun(organizationId, workspaceId, { ...input, budgetTokens: 120 }), w.org, { id: jobB.id, workspace_id: w.workspaceId, workflow_run_id: runB, config_digest: (control.prepare("SELECT config_digest FROM jobs WHERE id=?").get(jobB.id) as { config_digest: string }).config_digest });
      const listed = await w.brain.executeQuery(w.owner, { queryType: "contextPacks.forRun", workspaceId: w.workspaceId, resourceId: runB } as never) as unknown as { snapshot: { items: Array<{ manifest: { truncations: Array<{ sectionId: string; mode: string; reference: string }>; budgetTokens: number } }> } };
      const compact = listed.snapshot.items[0]!.manifest;
      expect(compact.budgetTokens).toBe(120);
      const cut = compact.truncations.find((entry) => entry.sectionId === "handoff-notes")!;
      expect(cut).toBeDefined();
      const fetched = await w.brain.executeQuery(w.owner, { queryType: "contextPacks.reference", workspaceId: w.workspaceId, resourceId: cut.reference } as never) as unknown as { snapshot: { text: string } };
      expect(fetched.snapshot.text).toContain(LONG_SUMMARY);
      await expect(w.brain.executeQuery(w.owner, { queryType: "contextPacks.reference", workspaceId: w.workspaceId, resourceId: `artifact:${sha256Digest(new TextEncoder().encode("nothing stored"))}` } as never)).rejects.toThrow(/no context reference/);
      // The first task, which has no dependencies, still gets its brief; the pack never contains member notes it was not given.
      expect(pack.text).not.toContain("Task b\nAcceptance criteria");
    });
  });
});

describe("the overall prompt budget (I4 residual)", () => {
  it("leaves the pack its own quarter of the ceiling when the brief is small, and shrinks it as the brief grows", () => {
    expect(contextBudget(32768, "short brief")).toBe(8192);
    // A long brief (~7000 tokens, the 28000-character situation) leaves the pack what half the ceiling allows after it.
    const long = "x".repeat(28000);
    expect(contextBudget(32768, long)).toBe(Math.min(8192, 16384 - 7000 - 1500));
    expect(contextBudget(16384, long)).toBe(256);
    // pack + brief + instructions never exceed half of the ceiling unless the floor applies.
    for (const [max, text] of [[8192, "a".repeat(2000)], [32768, "b".repeat(20000)], [16384, "c".repeat(4000)]] as const) {
      const pack = contextBudget(max, text);
      if (pack > 256) expect(pack + Math.ceil(text.length / 4) + 1500).toBeLessThanOrEqual(max / 2);
    }
  });
});
