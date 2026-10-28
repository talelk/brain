import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { setupWorld, stepUp, DIGEST_A } from "../helpers";
import { Brain } from "../../apps/governor/src/application/brain";
import { createBackup, restoreBackup, verifyBackup } from "../../apps/governor/src/modules/operations/index";

describe("G07 restore: hash-verified backup, suspended history, dead authority (E089/E081)", () => {
  it("restores history but no restored session, approval, lease, or permit can execute", async () => {
    const w = setupWorld();
    const s = w.brain.store;
    const digest = w.brain.activeRelease(w.org)!.digest;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-g07-run", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "g07-run",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "restore me" } },
    }, "g07");
    s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES ('runner-g07', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(w.org, DIGEST_A, s.now());
    for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
      s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-g07', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
    }
    const runner = { runnerId: "runner-g07", epoch: 1, organizationId: w.org };
    const offer = w.brain.claim(runner, "req-g07") as unknown as { attemptId: string; leaseId: string; jobFence: number; jobId: string };
    w.brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    const subject = {
      organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
      tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
      target: { targetId: "t-g07", environmentId: "prod", preconditionDigest: DIGEST_A },
      artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
      effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "g07-n1",
    };
    const approver = await w.grantApprover("g07-approver");
    const req = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-g07-apr", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "g07-apr", payload: { subject },
    }, "g07a");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const sdigest = approvalSubjectDigest(subject as unknown as JsonValue);
    const evidenceId = await stepUp(w, approver, approvalId, sdigest);
    w.brain.decideApproval(approver.identity, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "g07-dec", decision: "approve",
      subjectDigest: sdigest, expectedVersion: 1, note: "ok", stepUpEvidenceId: evidenceId,
    });
    const permit = w.brain.issuePermit(runner, offer.attemptId, { invocationId: "g07-inv", subjectDigest: sdigest, approvalId, resourceKeys: ["target:g07"] }) as unknown as { token: string };
    expect(w.brain.validatePermit(permit.token, "g07-inv")).toBe(true);
    const jobsBefore = (s.control.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    const eventsBefore = (s.control.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const oldToken = w.ownerToken;
    const dataDir = w.dir;
    w.brain.close();

    const backupDir = mkdtempSync(join(tmpdir(), "brain-backup-"));
    const manifest = await createBackup(dataDir, backupDir);
    // Local mode: memory (control.db memory_assets), the Mastra LibSQL
    // snapshot and the authority watermarks are all inside the archive; only
    // a configured remote TencentDB would be missing.
    expect(manifest.completeness).toBe(process.env["BRAIN_TENCENTDB_URL"] ? "partial" : "complete");
    expect(manifest.authority?.organizations.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(manifest.authority?.mastraLibsqlSnapshot).toBe(true);
    expect(manifest.authority?.memoryMode).toBe(process.env["BRAIN_TENCENTDB_URL"] ? "tencentdb" : "local");
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(verifyBackup(backupDir).files.length).toBe(manifest.files.length);

    // Tampered backups fail hash verification.
    const tampered = mkdtempSync(join(tmpdir(), "brain-backup-tamper-"));
    await createBackup(dataDir, tampered);
    const victim = join(tampered, manifest.files[0]!.path);
    writeFileSync(victim, Buffer.concat([readFileSync(victim), Buffer.from("x")]));
    expect(() => verifyBackup(tampered)).toThrow(/hash mismatch/);

    const restoredDir = join(mkdtempSync(join(tmpdir(), "brain-restored-")), "data");
    restoreBackup(backupDir, restoredDir);
    expect(existsSync(join(restoredDir, "RESTORED-SUSPENDED.json"))).toBe(true);

    const restored = new Brain({ dataDir: restoredDir, allowTestActor: true });
    try {
      const rs = restored.store;
      // History preserved.
      expect((rs.control.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(jobsBefore);
      expect((rs.control.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(eventsBefore);
      const ws = rs.workspaceDb(w.workspaceId, w.org);
      expect((ws.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(1);
      // Old authority is dead.
      expect(rs.control.prepare("SELECT 1 FROM inbox WHERE source_id='operations.restore'").get()).toBeTruthy();
      await expect(restored.resolveActor(new Headers({ authorization: `Bearer ${oldToken}` }))).rejects.toThrow();
      const approval = rs.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approvalId) as { state: string };
      expect(approval.state).toBe("revoked");
      const job = rs.control.prepare("SELECT state FROM jobs WHERE id=?").get(offer.jobId) as { state: string };
      expect(job.state).toBe("outcome_unknown");
      const attempt = rs.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(offer.attemptId) as { state: string };
      expect(attempt.state).toBe("outcome_unknown");
      expect(restored.validatePermit(permit.token, "g07-inv")).toBe(false);
      const sessions = rs.control.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number };
      expect(sessions.n).toBe(0);
      // Reopening does not re-quarantine (applied exactly once).
      const gen = (rs.control.prepare("SELECT revocation_generation AS g FROM organizations WHERE id=?").get(w.org) as { g: number }).g;
      restored.close();
      const again = new Brain({ dataDir: restoredDir, allowTestActor: true });
      const gen2 = (again.store.control.prepare("SELECT revocation_generation AS g FROM organizations WHERE id=?").get(w.org) as { g: number }).g;
      expect(gen2).toBe(gen);
      again.close();
    } catch (e) {
      try { restored.close(); } catch { /* already closed */ }
      throw e;
    }
  });

  it("restores twice from the same archive and refuses mixed archive parts (T47)", async () => {
    const w = await setupWorld();
    const dataDir = w.dir;
    w.brain.close();
    const backupDir = mkdtempSync(join(tmpdir(), "brain-backup2-"));
    const manifest = await createBackup(dataDir, backupDir);
    const watermarks = manifest.authority?.organizations ?? [];
    expect(watermarks.length).toBeGreaterThanOrEqual(1);

    // Second restore of previously restored data: a restored directory can be
    // re-restored from the same archive deterministically.
    const first = join(mkdtempSync(join(tmpdir(), "brain-restored-a-")), "data");
    restoreBackup(backupDir, first);
    const second = join(mkdtempSync(join(tmpdir(), "brain-restored-b-")), "data");
    restoreBackup(backupDir, second);
    const markerOf = (dir: string) => JSON.parse(readFileSync(join(dir, "RESTORED-SUSPENDED.json"), "utf8")) as { authorityWatermarks?: Array<{ id: string; revocationGeneration: number }> };
    expect(markerOf(second).authorityWatermarks).toEqual(markerOf(first).authorityWatermarks);
    expect(markerOf(second).authorityWatermarks?.length ?? 0).toBeGreaterThanOrEqual(1);
    // Both restores boot and carry the archived authority generation.
    for (const dir of [first, second]) {
      const b = new Brain({ dataDir: dir, allowTestActor: true });
      try {
        const gen = (b.store.control.prepare("SELECT revocation_generation AS g FROM organizations WHERE id=?").get(w.org) as { g: number } | undefined)?.g;
        // Startup quarantine bumps the generation; it must never be behind
        // the archived watermark.
        expect(gen ?? 0).toBeGreaterThanOrEqual(watermarks.find((x) => x.id === w.org)?.revocationGeneration ?? 0);
      } finally { b.close(); }
    }

    // Mixed archive parts: a marker claiming a HIGHER authority generation
    // than the restored control.db carries is refused at startup quarantine.
    const tampered = join(mkdtempSync(join(tmpdir(), "brain-restored-c-")), "data");
    restoreBackup(backupDir, tampered);
    const markerPath = join(tampered, "RESTORED-SUSPENDED.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { authorityWatermarks?: Array<{ id: string; revocationGeneration: number }> };
    marker.authorityWatermarks = (marker.authorityWatermarks ?? []).map((x) => ({ ...x, revocationGeneration: x.revocationGeneration + 5 }));
    writeFileSync(markerPath, JSON.stringify(marker));
    let refused = false;
    try { new Brain({ dataDir: tampered, allowTestActor: true }); }
    catch (e) { refused = /behind the archive|inconsistent/u.test(String((e as Error).message)); }
    finally { rmSync(tampered, { recursive: true, force: true }); }
    expect(refused).toBe(true);
  });
});
