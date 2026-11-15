import { describe, expect, it } from "vitest";
import { JobProtocol } from "../../apps/governor/src/modules/jobs/index";
import { createStreamService } from "../../apps/governor/src/modules/stream/index";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// A failed attempt says why, everywhere a person looks: the run page's read model, the attempt's log (an error record) and the
// stored reason, all from the failed step's own error, redacted and short.

type Offer = { attemptId: string; jobId: string; leaseId: string; jobFence: number };

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3_600_000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

async function failedAttempt(w: TestWorld, key: string, error: string): Promise<Offer> {
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: key } },
  }, key);
  const runner = seedRunner(w, `runner-${key}`);
  const protocol = new JobProtocol(w.brain.store, {
    completeStep: () => undefined, evaluatorEligible: () => true, runnerCurrent: () => true, activeRelease: () => undefined,
    resolveWorkflow: () => ({ workflow: {}, configDigest: `sha256:${"0".repeat(64)}` }), startRun: () => ({ runId: "unused" }),
  });
  const offer = protocol.claim(runner, `req-${key}`) as Offer;
  protocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  protocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { error } });
  return offer;
}

describe("a failed attempt carries its reason", () => {
  it("stores a short redacted reason, shows it in the run's read model and writes an error record to the attempt's log", async () => {
    const w = setupWorld();
    try {
      const secret = "sk-ant-0123456789abcdefghijkl";
      const image = "Unable to find image 'brain-sandbox-evaluator:latest' locally";
      const offer = await failedAttempt(w, "why-1", `sandboxed execution failed: sandbox create failed 503: docker run failed: ${image} (ANTHROPIC_API_KEY=${secret}) ${"x".repeat(900)}`);

      const stored = w.brain.store.control.prepare("SELECT failure_reason AS r FROM job_attempts WHERE id=?").get(offer.attemptId) as { r: string };
      expect(stored.r).toContain(image);
      expect(stored.r).not.toContain(secret);
      expect(stored.r.length).toBeLessThanOrEqual(500);

      const view = (await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: offer.jobId } as never)) as unknown as { snapshot: { attempts: Array<{ attemptId: string; state: string; failureReason?: string; failureCode?: string }> } };
      expect(view.snapshot.attempts).toEqual([expect.objectContaining({ attemptId: offer.attemptId, state: "failed", failureCode: "sandbox-image-missing", failureReason: stored.r })]);

      const stream = createStreamService(w.brain.store);
      stream.project();
      const page = stream.read(w.owner, { workspaceId: w.workspaceId, attemptId: offer.attemptId }, 50);
      const failed = page.items.find((item) => item.eventType === "attempt.failed");
      expect(failed).toMatchObject({ severity: "error", emitter: "governor", correlation: { attemptId: offer.attemptId, jobId: offer.jobId } });
      expect(JSON.stringify(failed?.summary)).toContain(image);
      expect(JSON.stringify(page.items)).not.toContain(secret);
    } finally {
      w.brain.close();
    }
  });

  it("an engine failure keeps its real cause (budget, schema, tool, context, abort), redacted and within 500 characters", async () => {
    const w = setupWorld();
    try {
      const secret = "sk-ant-0123456789abcdefghijkl";
      const budget = "agent ended with error: budget: the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written";
      const offer = await failedAttempt(w, "why-3", `${budget} (api_key=${secret})`);
      const stored = w.brain.store.control.prepare("SELECT failure_reason AS r FROM job_attempts WHERE id=?").get(offer.attemptId) as { r: string };
      expect(stored.r).toContain(budget);
      expect(stored.r).not.toContain(secret);
      expect(stored.r).not.toBe("agent ended with error");

      const long = await failedAttempt(w, "why-4", `agent ended with error: context overflow: ${"400 maximum context length ".repeat(80)}`);
      const cut = w.brain.store.control.prepare("SELECT failure_reason AS r FROM job_attempts WHERE id=?").get(long.attemptId) as { r: string };
      expect(cut.r.startsWith("agent ended with error: context overflow: ")).toBe(true);
      expect(cut.r.length).toBeLessThanOrEqual(500);
    } finally {
      w.brain.close();
    }
  });

  it("an attempt whose engine sandbox could not start fails with a sandbox failure code, never a silent downgrade (ADR 0065)", async () => {
    const w = setupWorld();
    try {
      const codeOf = async (key: string, error: string): Promise<{ code: string | undefined; reason: string | undefined }> => {
        const offer = await failedAttempt(w, key, error);
        const view = (await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: offer.jobId } as never)) as unknown as { snapshot: { attempts: Array<{ failureReason?: string; failureCode?: string }> } };
        return { code: view.snapshot.attempts[0]?.failureCode, reason: view.snapshot.attempts[0]?.failureReason };
      };
      const image = await codeOf("sbx-1", "engine sandbox create failed 503: docker run failed: Unable to find image 'brain-sandbox-engine:latest' locally");
      expect(image).toEqual({ code: "sandbox-image-missing", reason: expect.stringContaining("brain-sandbox-engine") });
      const refused = await codeOf("sbx-2", "engine sandbox create failed: this runner has no launcher, and pi does not run in the runner itself");
      expect(refused.code).toBe("sandbox-unavailable");
      expect((await codeOf("sbx-3", "engine sandbox exec failed: the container ended before the step finished")).code).toBe("sandbox-unavailable");
    } finally {
      w.brain.close();
    }
  });

  it("an attempt that failed without an error says nothing it does not know", async () => {
    const w = setupWorld();
    try {
      const offer = await failedAttempt(w, "why-2", "");
      const row = w.brain.store.control.prepare("SELECT failure_reason AS r FROM job_attempts WHERE id=?").get(offer.attemptId) as { r: string | null };
      expect(row.r).toBeNull();
    } finally {
      w.brain.close();
    }
  });
});
