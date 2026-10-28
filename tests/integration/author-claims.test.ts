import { describe, expect, it } from "vitest";
import { tempBrain, setupWorld } from "../helpers";
import { authorEvidenceFor } from "../../apps/governor/src/modules/evidence/index";

// T27: the author's claim structure is computed by the Governor from the
// pinned release and run — the runner never invents criteria, oracles or
// source revisions. Claims match the derivation the evidence acceptance
// validates against.
describe("author evidence claims (T27)", () => {
  it("derives source revision, primitive versions and evaluator claims from the release", async () => {
    const w = await setupWorld();
    const { brain } = w;
    const digest = "sha256:" + "1".repeat(64);
    const ws = brain.store.workspaceDb(w.workspaceId, w.org);
    // Minimal workflow run + inputs naming an evaluator job from the golden release.
    brain.store.control.prepare("INSERT OR IGNORE INTO config_releases(digest, organization_id, source_revision, compiler_digest, manifest_json, created_at_ms) VALUES (?,?,'rev-author-test','sha256:" + "3".repeat(64) + "',?,?)")
      .run(digest, w.org, JSON.stringify({
        manifest: { primitiveVersions: { "prim.echo": "sha256:" + "4".repeat(64) } },
        workflows: {}, evaluators: {
          "fixture-evaluator": { spec: { requiredChecks: ["echo-works", "verify-passes"] } },
        },
      }), brain.store.now());
    ws.prepare("INSERT INTO workflow_runs(id, execution_key, config_digest, workflow_digest, adapter_digest, engine_run_id, state, input_digest, created_at_ms) VALUES ('run-author-1', 'exec-author-1', ?, 'sha256:" + "5".repeat(64) + "', 'sha256:" + "7".repeat(64) + "', 'engine-1', 'running', 'sha256:" + "8".repeat(64) + "', ?)").run(digest, brain.store.now());
    ws.prepare("CREATE TABLE IF NOT EXISTS run_inputs(run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id), input_json TEXT NOT NULL, workflow_json TEXT NOT NULL, actor_id TEXT NOT NULL) STRICT").run();
    ws.prepare("INSERT INTO run_inputs(run_id, input_json, workflow_json, actor_id) VALUES ('run-author-1', '{}', ?, 'owner-1')").run(JSON.stringify({
      spec: { jobs: { verify: { kind: "eval", evaluator: { id: "fixture-evaluator", digest: "sha256:" + "6".repeat(64) } } } },
    }));

    const claims = authorEvidenceFor(brain.store, w.org, w.workspaceId, "run-author-1", digest);
    expect(claims.sourceRevision).toBe("rev-author-test");
    expect(claims.primitiveVersions["prim.echo"]).toBe("sha256:" + "4".repeat(64));
    expect(claims.claimedChecks.map((c) => c.checkId)).toEqual(["echo-works", "verify-passes"]);
    expect(claims.claimedChecks.every((c) => c.status === "passed" && c.oracleDigest === "sha256:" + "6".repeat(64))).toBe(true);
    expect(claims.claimedChecks[0]!.detail).toContain("independent evaluator required");
  });

  it("returns an empty claim set for unknown releases or runs instead of inventing one", async () => {
    const { brain } = tempBrain();
    const claims = authorEvidenceFor(brain.store, "org-x", "ws-x", "run-x", "sha256:" + "9".repeat(64));
    expect(claims.claimedChecks).toEqual([]);
    expect(claims.sourceRevision).toBe("");
    brain.close();
  });
});
