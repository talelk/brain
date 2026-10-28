import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "@brain/contracts/validate";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { compileRelease } from "../../apps/governor/src/modules/configuration/compiler";
import { collectRelease } from "../../apps/cli/src/release";
import { setupWorld } from "../helpers";

import { fixtureStarter } from "../support/starter";

describe("starter agent dispatch through real Governor and supervisor", () => {
  it("pins instructions and output, submits author evidence, and accepts an independent validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-agent-dispatch-"));
    const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    try {
      const world = setupWorld(app.brain);
      const b = fixtureStarter();
      const { digest } = world.brain.stageRelease(world.owner, b.documents, b.sourceRevision, b.scripts, b.instructions, b.schemas);
      world.brain.activateRelease(world.owner, digest);
      const catalog = world.brain.executeQuery(world.owner, { queryType: "agents.list", workspaceId: world.workspaceId });
      expect(validate("QueryResponse", catalog)).toEqual({ ok: true, errors: [] });
      const workflows = world.brain.executeQuery(world.owner, { queryType: "workflows.list", workspaceId: world.workspaceId });
      expect(validate("QueryResponse", workflows)).toEqual({ ok: true, errors: [] });
      const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
      const caps = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"];
      const cfg = (group: string) => ({ governorUrl: "http://127.0.0.1:3000", runnerId: `runner-${group}`, stateDir: join(root, group), capabilities: caps, engines: ["fixture"], transport });
      const author = cfg("agents"); const evaluator = cfg("evaluators");
      const authorSession = await enrollAndHello(author, world.brain.issueEnrollment(world.owner, "agents").token);
      const evalSession = await enrollAndHello(evaluator, world.brain.issueEnrollment(world.owner, "evaluators").token);
      const { receipt } = world.brain.executeCommand(world.owner, {
        contractVersion: "brain.command/v1", commandType: "workflow.dispatch", commandId: "cmd-agent-smoke", idempotencyKey: "agent-smoke",
        workspaceId: world.workspaceId, payload: { workflow: { id: "agent-smoke", digest }, input: { message: "BRAIN_OK" } },
      }, "corr-agent-smoke");
      const runId = receipt.resourceId!;
      expect(await runOnce(author, authorSession.sessionToken, authorSession.epoch)).toBe(true);
      const ws = world.brain.store.workspaceDb(world.workspaceId, world.org);
      expect(ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId)).toEqual({ state: "running" });
      expect(world.brain.store.control.prepare("SELECT j.state,a.receipt_digest FROM jobs j JOIN job_attempts a ON a.job_id=j.id WHERE j.workflow_run_id=?").all(runId)).toEqual(expect.arrayContaining([expect.objectContaining({ state: "verifying" })]));
      expect(ws.prepare("SELECT state FROM evidence_bundles").get()).toEqual({ state: "submitted" });
      expect(await runOnce(evaluator, evalSession.sessionToken, evalSession.epoch)).toBe(true);
      expect(ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId)).toEqual({ state: "succeeded" });
      expect(ws.prepare("SELECT outcome FROM verification_verdicts").get()).toEqual({ outcome: "verified" });
      const output = ws.prepare("SELECT output_json FROM step_outputs WHERE run_id=? AND step_id='respond'").get(runId) as { output_json: string };
      expect(JSON.parse(output.output_json)).toBe("BRAIN_OK");
      expect(world.brain.store.control.prepare("SELECT COUNT(*) AS n FROM artifact_associations WHERE owner_kind='attempt'").get()).toEqual({ n: 3 });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});


describe("complete starter release compilation", () => {
  function compile(bundle: ReturnType<typeof collectRelease>) {
    return compileRelease(bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  }
  it("pins all three agents, instructions, schemas, and the independent validator", () => {
    const release = compile(collectRelease("examples/v1/starter-release"));
    expect(Object.keys(release.agents)).toHaveLength(3);
    expect(Object.keys(release.workflows)).toHaveLength(3);
    expect(Object.keys(release.schemas).length).toBeGreaterThanOrEqual(6);
  });
  it.each(["missing instructions", "ambiguous instructions", "missing schema", "digest mismatch", "unknown agent", "engine mismatch", "unknown workflow", "cycle"])("rejects %s before activation", (scenario) => {
    const bundle = collectRelease("examples/v1/starter-release");
    if (scenario === "missing instructions") bundle.instructions.splice(0, 1);
    if (scenario === "ambiguous instructions") bundle.instructions.push(bundle.instructions[0]!);
    if (scenario === "missing schema") bundle.schemas.splice(0, bundle.schemas.length);
    const doc = bundle.documents.find((entry) => JSON.parse(entry.text).metadata.id === "agent-smoke")!;
    const workflow = JSON.parse(doc.text);
    if (scenario === "digest mismatch") workflow.spec.jobs.respond.uses.release.digest = `sha256:${"f".repeat(64)}`;
    if (scenario === "unknown agent") workflow.spec.jobs.respond.uses.release.id = "missing-agent";
    if (scenario === "engine mismatch") workflow.spec.jobs.respond.runsOn.engine = { anyOf: ["fixture"], features: ["sessions"] };
    if (scenario === "unknown workflow") workflow.spec.jobs.missing = { kind: "subgraph", needs: [], workflow: { id: "missing-workflow", digest: `sha256:${"f".repeat(64)}` }, with: {} };
    if (scenario === "cycle") workflow.spec.jobs.respond.needs = ["respond"];
    doc.text = JSON.stringify(workflow);
    expect(() => compile(bundle)).toThrow();
  });
});
