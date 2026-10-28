import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";
import { bundleForAttempt } from "../support/evidence";

type World = ReturnType<typeof setupWorld>;

function seedRunner(w: World, runnerId: string) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

interface Offer { attemptId: string; leaseId: string; jobFence: number; jobId: string }
function completedAttempt(w: World, key: string, runnerId: string) {
  const digest = w.brain.activeRelease(w.org)!.digest;
  w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  const runner = seedRunner(w, runnerId);
  const offer = w.brain.claim(runner, `req-${key}`) as unknown as Offer;
  w.brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  w.brain.completeAttempt(runner, offer.attemptId, { result: "succeeded", output: { message: "Brain fixture" }, jobFence: offer.jobFence, cleanupConfirmed: true });
  return { runner, offer };
}

describe("evidence admission security (T28)", () => {
  it("rejects bundles with invented fences, foreign attempts, and self-verdicts", () => {
    const w = setupWorld();
    const { runner, offer } = completedAttempt(w, "ev-sec", "runner-evsec");
    const bundle = bundleForAttempt(w.brain, w.org, w.workspaceId, offer.attemptId, "bundle-sec-1");
    expect(() => w.brain.submitEvidence(runner, { ...bundle, jobFence: offer.jobFence + 99 } as never)).toThrow();
    const foreign = seedRunner(w, "runner-foreign");
    expect(() => w.brain.submitEvidence(foreign, bundle as never)).toThrow();
    const submitted = w.brain.submitEvidence(runner, bundle as never) as unknown as { digest: string };
    expect(submitted.digest).toBeTruthy();
    const verdict = (bundleDigest: string, evaluatorAttemptId: string) => ({
      contractVersion: "brain.verdict/v1", bundleDigest, evaluatorAttemptId,
      evaluatorRelease: { id: "fixture-evaluator", digest: DIGEST_A },
      independence: { authorAttemptId: offer.attemptId, evaluatorAttemptId, trustDomain: "fixture", authorTrustDomain: "fixture-tools", evaluatorTrustDomain: "fixture" },
      outcome: "verified", checks: [], acceptedBy: "owner-1", createdAt: new Date().toISOString(),
    });
    expect(() => w.brain.acceptVerdict(runner, w.workspaceId, verdict(submitted.digest, offer.attemptId))).toThrow();
    expect(() => w.brain.acceptVerdict(foreign, w.workspaceId, verdict(`sha256:${"f".repeat(64)}`, "eval-x"))).toThrow();
    w.brain.close();
  });
});
