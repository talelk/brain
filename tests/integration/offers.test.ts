import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { setupWorld, DIGEST_A } from "../helpers";

describe("JobOffer runtime conformance (T02)", () => {
  it("claim returns a schema-valid JobOffer whose execution artifact is fetchable and digest-true", () => {
    const w = setupWorld();
    const s = w.brain.store;
    const digest = w.brain.activeRelease(w.org)!.digest;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-offer", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "offer-1",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
    }, "offer-1");
    s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES ('runner-offer', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(w.org, DIGEST_A, s.now());
    for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
      s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-offer', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
    }
    const runner = { runnerId: "runner-offer", epoch: 1, organizationId: w.org };
    const offer = w.brain.claim(runner, "req-offer") as unknown as Record<string, unknown>;
    expect(offer).toBeTruthy();
    const check = validate("JobOffer", offer);
    expect(check.ok, check.ok ? "" : check.errors.join("; ")).toBe(true);
    expect(offer["payload"]).toBeUndefined();
    const execution = offer["execution"] as { kind: string; artifact: { artifactId: string; digest: string; bytes: number } };
    expect(execution.kind).toBe("tool");
    const bytes = w.brain.readExecutionArtifact(runner, String(offer["attemptId"]));
    expect(sha256Digest(bytes)).toBe(execution.artifact.digest);
    expect(bytes.length).toBe(execution.artifact.bytes);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { input?: { message?: string } };
    expect(payload.input?.message).toBe("Brain fixture");
    // Another runner cannot read the attempt's execution artifact.
    expect(() => w.brain.readExecutionArtifact({ runnerId: "runner-other", epoch: 1, organizationId: w.org }, String(offer["attemptId"]))).toThrow();
    // Workflow digest is the run's pinned workflow digest, not the release digest.
    const ws = s.workspaceDb(w.workspaceId, w.org);
    const runRow = ws.prepare("SELECT workflow_digest, config_digest FROM workflow_runs LIMIT 1").get() as { workflow_digest: string; config_digest: string };
    expect(offer["workflowDigest"]).toBe(runRow.workflow_digest);
    expect(offer["configDigest"]).toBe(runRow.config_digest);
    w.brain.close();
  });
});
