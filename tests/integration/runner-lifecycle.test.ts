import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { DIGEST_A, setupWorld } from "../helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("runner enrollment and administrative lifecycle", () => {
  it("rotates identity, requires fresh enable evidence and preserves deregistered history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-runner-lifecycle-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const now = w.brain.store.now();
    w.brain.store.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity)
      VALUES ('runner-lifecycle',?,'fixture-tools','old-key','disabled','healthy',?,1,?,4000,8192,20480,1)`).run(w.org, DIGEST_A, now);
    w.brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES ('runner-lifecycle','os:linux',1,'probe',?,?)").run(now, now + 300_000);
    w.brain.store.control.prepare("INSERT INTO runner_identity_credentials(runner_id,public_key_spki_pem,credential_digest,expires_at_ms) VALUES ('runner-lifecycle','old-public-key','old-credential',?)").run(now + 300_000);
    const run = (key: string, action: "enable" | "disable" | "rotate" | "deregister") => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: key, idempotencyKey: key, commandType: "runner.control",
      payload: { runnerId: "runner-lifecycle", action, reason: `Lifecycle ${action}` },
    }, key).receipt;

    expect(run("enable-initial", "enable").accepted).toBe(true);
    expect(run("disable-for-rotation", "disable").accepted).toBe(true);
    expect(run("rotate-identity", "rotate").accepted).toBe(true);
    expect(w.brain.store.control.prepare("SELECT revoked_at_ms FROM runner_identity_credentials WHERE runner_id='runner-lifecycle'").get()).toEqual({ revoked_at_ms: expect.any(Number) });
    const enrollment = w.brain.issueEnrollment(w.owner, "fixture-tools");
    w.brain.enrollRunner({ token: enrollment.token, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nreplacement\n-----END PUBLIC KEY-----", runnerId: "runner-lifecycle" });
    expect(w.brain.store.control.prepare("SELECT admin_state FROM runners WHERE id='runner-lifecycle'").get()).toEqual({ admin_state: "disabled" });
    expect(() => run("enable-offline", "enable")).toThrow(/current heartbeat/);
    w.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='runner-lifecycle'").run(w.brain.store.now());
    expect(run("enable-verified", "enable").accepted).toBe(true);

    const jobNow = w.brain.store.now();
    w.brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms,attempt_counter,job_fence)
      VALUES ('job-runner-lifecycle',?,?,'job-runner-lifecycle','run-runner-lifecycle','step','running',?,'{}',?,'read',?,?,?,1,1)`)
      .run(w.org, w.workspaceId, w.brain.activeRelease(w.org)!.digest, DIGEST_A, jobNow, jobNow, jobNow + 60_000);
    w.brain.store.control.prepare(`INSERT INTO job_attempts(id,job_id,runner_id,runner_epoch,attempt_no,lease_id,job_fence,state,offer_expires_at_ms,lease_expires_at_ms)
      VALUES ('attempt-runner-lifecycle','job-runner-lifecycle','runner-lifecycle',2,1,'lease-runner-lifecycle',1,'running',?,?)`).run(jobNow + 60_000, jobNow + 60_000);
    const heartbeat = w.brain.store.control.prepare("SELECT last_heartbeat_ms FROM runners WHERE id='runner-lifecycle'").get() as { last_heartbeat_ms: number };
    const detail = w.brain.executeQuery(w.owner, { queryType: "runner.get", resourceId: "runner-lifecycle" }) as { snapshot: { activeAttemptIds: string[]; lastSeenAt: string } };
    expect(detail.snapshot.activeAttemptIds).toEqual(["attempt-runner-lifecycle"]);
    expect(detail.snapshot.lastSeenAt).toBe(new Date(heartbeat.last_heartbeat_ms).toISOString());
    expect(() => run("deregister-active", "deregister")).toThrow(/active or unresolved/);
    w.brain.store.control.prepare("DELETE FROM job_attempts WHERE id='attempt-runner-lifecycle'").run();
    w.brain.store.control.prepare("DELETE FROM jobs WHERE id='job-runner-lifecycle'").run();

    expect(run("deregister-clean", "deregister").accepted).toBe(true);
    const fleet = w.brain.executeQuery(w.owner, { queryType: "runners.list" }) as { snapshot: { items: Array<{ runnerId: string }> } };
    expect(fleet.snapshot.items.some((runner) => runner.runnerId === "runner-lifecycle")).toBe(false);
    const retired = w.brain.executeQuery(w.owner, { queryType: "runner.get", resourceId: "runner-lifecycle" }) as { snapshot: { deregisteredAt?: string } };
    expect(retired.snapshot.deregisteredAt).toEqual(expect.any(String));
    expect(() => run("enable-retired", "enable")).toThrow(/already deregistered/);
  });
});
