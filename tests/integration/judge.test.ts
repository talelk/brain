import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { parseJudgeResponse } from "../../apps/governor/src/modules/packs/judge";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// T44 optional judge: parsing fails closed (inconclusive, never passed),
// transcripts are CAS evidence, outcomes flow through the ordinary rubric
// path, and an unreachable model records nothing rather than guessing.
let server: Server | undefined;
let world: TestWorld | undefined;
afterEach(async () => {
  world?.brain.close(); world = undefined;
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
  delete process.env["BRAIN_LOCAL_MODEL_URL"];
});

describe("judge response parsing (T44)", () => {
  it("maps verdicts and fails closed on garbage", () => {
    expect(parseJudgeResponse('{"verdict":"pass","rationale":"ok"}')).toEqual({ outcome: "passed", rationale: "ok" });
    expect(parseJudgeResponse('text before {"verdict":"fail","rationale":"missing"} after')).toEqual({ outcome: "failed", rationale: "missing" });
    expect(parseJudgeResponse('{"verdict":"inconclusive","rationale":"weak"}').outcome).toBe("incomplete");
    expect(parseJudgeResponse("PASS definitely").outcome).toBe("incomplete");
    expect(parseJudgeResponse('{"verdict":"yes"}').outcome).toBe("incomplete");
    expect(parseJudgeResponse("").outcome).toBe("incomplete");
  });
});

async function mockJudge(verdict: string): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict, rationale: "evidence settles it" }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

describe("judge on a mission evidence bundle (T44)", () => {
  it("records advisory checks with transcript evidence, never a verdict, and never fabricates when the model is down", async () => {
    world = setupWorld();
    const w = world;
    const upload = (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const digest = sha256Digest(bytes);
      const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
      return (w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { digest: string }).digest;
    };
    const evidence = upload("Build log: all 42 checks green; artifact sha256 pinned.");
    const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
    } as never, key)).receipt;
    const version = async (id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { version: number } }).snapshot.version;
    const missionId = (await run("mission.create", "judge-mission", { title: "Release", intent: "Ship the release", successCriteria: ["All checks green"] })).resourceId ?? "";
    const planId = (await run("plan.propose", "judge-plan", { missionId, origin: "manual", tasks: [{ id: "ship", title: "Ship", criteria: ["ship-done"], dependsOn: [] }] })).resourceId ?? "";
    await run("plan.confirm", "judge-confirm", { planVersionId: planId }, await version(missionId));
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(DIGEST_A, missionId);
    await run("mission.proposeCompletion", "judge-verify", { missionId }, await version(missionId));
    process.env["BRAIN_LOCAL_MODEL_URL"] = await mockJudge("pass");
    const judged = await w.brain.judgeMissionBundle({ actor: w.owner, workspaceId: w.workspaceId, missionId, criteria: [{ criterionId: "c1", criterionText: "All checks green in the build log.", evidenceDigest: evidence }] });
    expect(judged).toEqual([expect.objectContaining({ criterionId: "c1", outcome: "passed" })]);
    const bundle = ((await w.brain.executeQuery(w.owner, { queryType: "missionBundles.latest", workspaceId: w.workspaceId, resourceId: missionId })) as { snapshot: { state: string; checks: Array<{ evaluator: string; advisory: boolean; outcome: string }> } }).snapshot;
    // A recommendation, not a verdict: the bundle stays submitted until an independent verdict is recorded.
    expect(bundle.state).toBe("submitted");
    expect(bundle.checks).toEqual([expect.objectContaining({ outcome: "passed", advisory: true, evaluator: expect.stringMatching(/^judge:qwen3\.8-flash-next-a5b$/) })]);
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://127.0.0.1:9/v1";
    await expect(w.brain.judgeMissionBundle({ actor: w.owner, workspaceId: w.workspaceId, missionId, criteria: [{ criterionId: "c2", criterionText: "x", evidenceDigest: evidence }] })).rejects.toThrow(/judge model unavailable/);
    expect((ws.prepare("SELECT COUNT(*) AS c FROM mission_bundle_checks WHERE criterion_id='c2'").get() as { c: number }).c).toBe(0);
    expect(() => w.brain.recordBundleCheck({ actor: w.owner, workspaceId: w.workspaceId, missionId, criterionId: "c3", evaluator: "eval-1", outcome: "passed", evidenceDigest: `sha256:${"f".repeat(64)}` })).toThrow(/evidence artifact not found/);
  }, 120_000);
});
