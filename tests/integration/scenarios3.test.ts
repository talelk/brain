import { seedOrganization } from "../helpers";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { setupWorld, tempBrain, DIGEST_A } from "../helpers";
import { Brain } from "../../apps/governor/src/application/brain";
import { GitLabConnector } from "../../apps/governor/src/modules/packs/index";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";

const cfgFor = (dir: string): RunnerConfig => ({ groupToolsDir: dir } as unknown as RunnerConfig);
const tool = (offer: ReturnType<typeof echoOffer>, dir: string) => ({ offer, cfg: cfgFor(dir) });
const echoOffer = (input: Record<string, unknown>) => ({
  payload: { step: { uses: { release: { id: "fixture.echo" } } }, input },
  execution: { kind: "tool" },
});

describe("scenario gaps (T50 batch 3: connectors, tools, storage)", () => {
  it("target without CAS/idempotency: readback reconciliation, uncertainty stays explicit (E057)", async () => {
    const notes = [{ body: "exact note body" }];
    const okFetch = (async () => new Response(JSON.stringify(notes), { status: 200 })) as typeof fetch;
    const gl = new GitLabConnector("https://gitlab.example", 7, "t", okFetch);
    await expect(gl.reconcileNote(3, "exact note body")).resolves.toEqual({ outcome: "applied" });
    await expect(gl.reconcileNote(3, "never written")).resolves.toEqual({ outcome: "absent" });
    const dupFetch = (async () => new Response(JSON.stringify([{ body: "x" }, { body: "x" }]), { status: 200 })) as typeof fetch;
    await expect(new GitLabConnector("https://gitlab.example", 7, "t", dupFetch).reconcileNote(3, "x")).resolves.toEqual({ outcome: "conflicting" });
    const downFetch = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
    await expect(new GitLabConnector("https://gitlab.example", 7, "t", downFetch).reconcileNote(3, "x")).resolves.toEqual({ outcome: "unknown" });
  });

  it("provider failures are classified: rate-limit retryable, auth/server bounded (E064)", async () => {
    const mk = (status: number) => new GitLabConnector("https://gitlab.example", 7, "t",
      (async () => new Response("err", { status })) as typeof fetch);
    await expect(mk(429).getIssue(1)).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await expect(mk(503).getIssue(1)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
    await expect(mk(401).getIssue(1)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: false });
    await expect(mk(404).getIssue(1)).rejects.toMatchObject({ retryable: false });
  });

  it("tool input cannot inject shell commands; unknown tool ids never resolve paths (E066)", async () => {
    const marker = join("/tmp", `bp-${Date.now()}`);
    const res = await executeToolPayload(
      tool(echoOffer({ message: `$(touch ${marker})` }), join(process.cwd(), "examples/v1/golden-release/tools")),
    );
    expect(res.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const traversal = await executeToolPayload(
      tool({ payload: { step: { uses: { release: { id: "../../etc/passwd" } } }, input: {} }, execution: { kind: "tool" } }, "/tmp"),
    );
    expect(traversal.ok).toBe(false);
  });

  it("tool exit 0 with invalid or oversized output is failed evidence, never Done (E068)", async () => {
    const w = tempBrain();
    const tools = join(w.dir, "tools");
    mkdirSync(join(tools, "fixture.echo"), { recursive: true });
    writeFileSync(join(tools, "fixture.echo", "run.sh"), "#!/bin/bash\necho 'not json at all'\n", { mode: 0o755 });
    const bad = await executeToolPayload(tool(echoOffer({ message: "x" }), tools));
    expect(bad.ok).toBe(false);
    writeFileSync(join(tools, "fixture.echo", "run.sh"), "#!/bin/bash\nhead -c 3000000 /dev/zero | tr '\\0' 'a'\n", { mode: 0o755 });
    const big = await executeToolPayload(tool(echoOffer({ message: "x" }), tools));
    expect(big.ok).toBe(false);
    w.brain.close();
  });

  it("tool nonzero exit after an observed mutation is failure evidence, not success (E069)", async () => {
    const w = tempBrain();
    const tools = join(w.dir, "tools");
    mkdirSync(join(tools, "fixture.echo"), { recursive: true });
    const sideEffect = join(w.dir, "mutated.txt");
    writeFileSync(join(tools, "fixture.echo", "run.sh"), `#!/bin/bash\necho mutated > ${sideEffect}\necho '{"partial":true}'\nexit 3\n`, { mode: 0o755 });
    const res = await executeToolPayload({ offer: echoOffer({ message: "x" }), cfg: cfgFor(tools) });
    expect(existsSync(sideEffect)).toBe(true); // mutation happened
    expect(res.ok).toBe(false); // yet the step is not successful: caller maps this to unknown-outcome
    expect(JSON.stringify(res.output)).toContain("tool exit 3");
    w.brain.close();
  });

  it("checkpoint is produced by the harness and the job can be re-attempted after absent-reconcile (E071)", async () => {
    const engine = new FixtureEngine();
    const cp = await engine.checkpoint() as unknown as { checkpointId: string; artifact: { digest: string } };
    expect(cp.checkpointId).toBeTruthy();
    expect(cp.artifact.digest).toMatch(/^sha256:/);
    const w = setupWorld();
    const s = w.brain.store;
    const { receipt } = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-cp-1", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "cp-1",
      payload: { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "x" } },
    }, "cp-1");
    void receipt;
    s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES ('runner-cp', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(w.org, DIGEST_A, s.now());
    for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
      s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-cp', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
    }
    const runner = { runnerId: "runner-cp", epoch: 1, organizationId: w.org };
    const offer = w.brain.claim(runner, "req-cp-1") as unknown as { attemptId: string; leaseId: string; jobFence: number; jobId: string; attemptNumber: number };
    w.brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    w.brain.completeAttempt(runner, offer.attemptId, { result: "unknown-outcome", output: {}, jobFence: offer.jobFence, cleanupConfirmed: false });
    w.brain.reconcileJob({ organizationId: w.org, jobId: offer.jobId, outcome: "absent", evidenceDigest: DIGEST_A });
    const next = w.brain.claim(runner, "req-cp-2") as unknown as { attemptNumber: number; jobFence: number };
    expect(next.attemptNumber).toBeGreaterThan(offer.attemptNumber);
    expect(next.jobFence).toBeGreaterThan(offer.jobFence); // new attempt, strictly newer fence: no ownership confusion
    w.brain.close();
  });

  it("SQLITE_BUSY during a command commits no partial authority and fails closed (E087)", async () => {
    const w = setupWorld();
    const locker = new Database(join(w.dir, "control.db"));
    locker.pragma("busy_timeout = 5000");
    locker.exec("BEGIN EXCLUSIVE");
    const cmd = {
      contractVersion: "brain.command/v1", commandId: "cmd-busy", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "busy-1", payload: { title: "busy", criteria: ["x"] },
    };
    expect(() => w.brain.executeCommand(w.owner, cmd, "busy")).toThrow();
    locker.exec("ROLLBACK");
    locker.close();
    const row = w.brain.store.control.prepare("SELECT command_id FROM command_idempotency WHERE idempotency_key='busy-1'").get();
    expect(row).toBeUndefined(); // nothing half-committed under the busy failure
    const ok = w.brain.executeCommand(w.owner, cmd, "busy-retry");
    expect(ok.receipt.accepted).toBe(true);
    w.brain.close();
  });

  it("CAS GC retains referenced and in-flight bytes; incomplete uploads never publish (E090)", async () => {
    const w = setupWorld();
    const bytes = new TextEncoder().encode("evidence-bytes");
    const digest = sha256Digest(bytes);
    const bad = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: DIGEST_A, expectedBytes: 3 }) as unknown as { uploadId: string };
    expect(() => w.brain.putUpload(w.owner, bad.uploadId, bytes)).toThrow(/mismatch/);
    expect(() => w.brain.readArtifact(w.owner, `art-${bad.uploadId}`)).toThrow();
    const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
    const put = w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { artifactId: string };
    expect(Buffer.from(w.brain.readArtifact(w.owner, put.artifactId)).equals(Buffer.from(bytes))).toBe(true);
    // Age everything far beyond the grace window; referenced bytes must survive.
    const casPath = w.brain.casPath(digest);
    const old = new Date(Date.now() - 90 * 24 * 3600_000);
    utimesSync(casPath, old, old);
    // An open upload names a second digest: its (pre-staged) bytes are in-flight and retained.
    const pendingBytes = new TextEncoder().encode("pending-bytes");
    const pendingDigest = sha256Digest(pendingBytes);
    w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: pendingDigest, expectedBytes: pendingBytes.length });
    const pendingPath = w.brain.casPath(pendingDigest);
    mkdirSync(join(pendingPath, ".."), { recursive: true });
    writeFileSync(pendingPath, pendingBytes);
    utimesSync(pendingPath, old, old);
    // Orphan bytes neither referenced nor in-flight are collected.
    const orphanDigest = sha256Digest(new TextEncoder().encode("orphan"));
    const orphanPath = w.brain.casPath(orphanDigest);
    mkdirSync(join(orphanPath, ".."), { recursive: true });
    writeFileSync(orphanPath, "orphan");
    utimesSync(orphanPath, old, old);
    const swept = w.brain.casSweep(1000);
    expect(swept.removed).toBe(1);
    expect(existsSync(casPath)).toBe(true);
    expect(existsSync(pendingPath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    expect(Buffer.from(w.brain.readArtifact(w.owner, put.artifactId)).equals(Buffer.from(bytes))).toBe(true);
    w.brain.close();
  });

  it("schema/protocol skew is refused with diagnostics, never converted (E100)", async () => {
    const w = tempBrain();
    seedOrganization(w.brain, { organizationId: "org-skew", ownerId: "owner-skew" });
    w.brain.close();
    const db = new Database(join(w.dir, "control.db"));
    db.prepare("UPDATE schema_metadata SET schema_digest=?").run(`sha256:${"f".repeat(64)}`);
    db.close();
    expect(() => new Brain({ dataDir: w.dir, allowTestActor: true })).toThrow(/does not match current target/);
    const w2 = setupWorld();
    expect(() => w2.brain.runnerHello({ contractVersion: "brain.runner/v2", runnerId: "x" })).toThrow(/unsupported/);
    expect(() => w2.brain.runnerHello({ runnerId: "x" })).toThrow(/unsupported/);
    w2.brain.close();
  });
});
