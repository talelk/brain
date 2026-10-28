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

describe("judge dossier flow (T44)", () => {
  it("records transcript evidence and never fabricates when the model is down", async () => {
    world = setupWorld();
    const w = world;
    const upload = (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const digest = sha256Digest(bytes);
      const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
      return (w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { digest: string }).digest;
    };
    const evidence = upload("Build log: all 42 checks green; artifact sha256 pinned.");
    const dossier = w.brain.createDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, sourceRevision: "r1", manifestDigest: DIGEST_A, rubricDigest: DIGEST_A });
    process.env["BRAIN_LOCAL_MODEL_URL"] = await mockJudge("pass");
    const judged = await w.brain.judgeDeliveryDossier({
      actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId,
      criteria: [{ criterionId: "c1", criterionText: "All checks green in the build log.", evidenceDigest: evidence }],
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]?.outcome).toBe("passed");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const row = ws.prepare("SELECT outcome, evaluator_attempt_id FROM rubric_results WHERE dossier_id=?").get(dossier.dossierId) as Record<string, unknown>;
    expect(row["outcome"]).toBe("passed");
    expect(String(row["evaluator_attempt_id"])).toMatch(/^judge:qwen3\.8-flash-next-a5b:/);
    // Finalize is still the only path to a verdict state.
    expect(w.brain.finalizeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, expectedVersion: 2 })).toEqual({ state: "verified" });
    await expect(w.brain.judgeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, criteria: [] })).rejects.toThrow(/finalized/);

    // Model down: explicit dependency failure, nothing recorded.
    const second = w.brain.createDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, sourceRevision: "r2", manifestDigest: DIGEST_A, rubricDigest: DIGEST_A });
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://127.0.0.1:9/v1";
    await expect(w.brain.judgeDeliveryDossier({
      actor: w.owner, workspaceId: w.workspaceId, dossierId: second.dossierId,
      criteria: [{ criterionId: "c1", criterionText: "x", evidenceDigest: evidence }],
    })).rejects.toThrow(/judge model unavailable/);
    const count = ws.prepare("SELECT COUNT(*) AS c FROM rubric_results WHERE dossier_id=?").get(second.dossierId) as { c: number };
    expect(count.c).toBe(0);
  }, 120_000);
});
