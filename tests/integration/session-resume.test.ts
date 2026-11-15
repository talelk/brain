import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { domainDigest, sha256Digest, type JsonValue, type SessionDetail } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { DIGEST_A, setupWorld } from "../helpers";
import { advance, clock, closeWorlds, confirmedMission, run, stageStarter, task, type Offer, type Runner, type World } from "../support/machine-session";

// ADR 0044: a session that left a checkpoint on a runner is resumed by a new session, in a new run whose continuing step only that runner may
// claim. The control is offered only when it can work. State is reached through commands and the runner protocol, never through table writes.

const dirs: string[] = [];
afterEach(() => { closeWorlds(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const FEATURES = ["sessions", "checkpoint", "resume"];

/** A runner whose engine states it can checkpoint and resume (as the Pi engine does), enrolled through the runner protocol. */
function register(w: World, runnerId: string, features: readonly string[] = FEATURES): Runner {
  const protocol = w.brain.jobProtocol;
  const { token } = protocol.issueEnrollment(w.owner, "agents");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { credential } = protocol.enrollRunner({ token, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), runnerId });
  const challenge = protocol.challenge(runnerId, credential);
  const capabilities = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: [...features] }])];
  const at = clock.nowMs();
  const body: Record<string, unknown> = {
    contractVersion: "brain.runner/v1", runnerId, bootNonce: `boot-${runnerId}`, runtimeVersion: "test", configDigest: DIGEST_A,
    capacity: { cpuMillicores: 16000, memoryMb: 32768, diskMb: 40960, slots: 4 }, engines: [], isolationModes: ["ephemeral-container"],
    capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 3_600_000).toISOString() })),
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId: challenge.challengeId, nonce: challenge.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
  const { epoch } = protocol.hello({ ...body, proof: { challengeId: challenge.challengeId, signatureBase64url: sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url") } });
  return { runnerId, epoch, organizationId: w.org };
}

/** The runner claims the next job and starts its attempt on an engine that says it can checkpoint and resume. */
function started(w: World, runner: Runner, key: string): Offer {
  const offer = w.brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as Offer;
  expect(offer, `${runner.runnerId} was offered the task`).toBeTruthy();
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: FEATURES } });
  return offer;
}

/** What the engine saved: its conversation, kept on the runner that took it. */
function checkpointOf(offer: Offer, withEngineState = true): Record<string, unknown> {
  return {
    contractVersion: "brain.checkpoint/v2", attemptId: offer.attemptId, sourceRevision: DIGEST_A,
    ...(withEngineState ? { engineState: { artifactId: `fixture-checkpoint-${offer.attemptId}`, digest: sha256Digest(new TextEncoder().encode(offer.attemptId)), bytes: offer.attemptId.length, mediaType: "application/x-ndjson", classification: "internal" } } : {}),
    completedCriteria: [], failures: [], worktreeId: "read-only:workspace", eventSequence: 0, ownedResources: [], nextAction: "continue the saved conversation", createdAt: new Date(clock.nowMs()).toISOString(),
  };
}

/** The attempt did not finish: its runner reports the failure and leaves the checkpoint with the Governor's record of who holds it. */
function failedWith(w: World, runner: Runner, offer: Offer, checkpoint: Record<string, unknown> | undefined): void {
  w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", output: { error: "the model stopped answering" }, jobFence: offer.jobFence, cleanupConfirmed: true, ...(checkpoint ? { checkpoint } : {}) });
}

let beat = 0;
/** The runner's heartbeat, as the real one sends it: it is the proof the runner is still there, and may restate what its engine can do. */
function heartbeat(w: World, runner: Runner, features: readonly string[] = FEATURES): void {
  const at = new Date(clock.nowMs()).toISOString();
  const capabilities = ["os:linux", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: [...features] }])];
  w.brain.jobProtocol.heartbeat(runner, { sequence: ++beat, health: "healthy", capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: at, expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString() })) });
}

const sessions = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "sessions.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: SessionDetail[] } }).snapshot.items;
const sessionOf = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: SessionDetail }).snapshot;
const explained = async (w: World, jobId: string) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "job.explain", workspaceId: w.workspaceId, resourceId: jobId } as never)) as unknown as { snapshot: { runners: Array<{ runnerId: string; eligible: boolean; reasons: string[] }> } }).snapshot.runners;

/** A mission whose one task a runner started and failed, leaving a checkpoint; the world's clock is the test's. */
async function interrupted(options: { checkpoint?: boolean | "no-state"; engineFeatures?: readonly string[] } = {}): Promise<{ w: World; a: Runner; b: Runner; sessionId: string; offer: Offer; workItemId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-session-resume-"));
  dirs.push(dir);
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock }));
  stageStarter(w);
  const { workItemId } = await confirmedMission(w, { tasks: [task("a")] });
  const a = register(w, "runner-a", options.engineFeatures);
  const b = register(w, "runner-b", options.engineFeatures);
  const offer = started(w, a, "first");
  failedWith(w, a, offer, options.checkpoint === false ? undefined : checkpointOf(offer, options.checkpoint !== "no-state"));
  const ended = (await sessions(w)).find((entry) => entry.attemptId === offer.attemptId);
  expect(ended, "the attempt's session exists").toBeDefined();
  return { w, a, b, sessionId: ended!.sessionId, offer, workItemId };
}

describe("resuming a session from its checkpoint (ADR 0044)", () => {
  it("offers the resume only on the runner that holds the checkpoint, and a resume starts a new session there from it", async () => {
    const { w, a, b, sessionId, offer } = await interrupted();
    const before = await sessionOf(w, sessionId);
    expect(before.state).toBe("failed");
    expect(before.checkpoint).toEqual(expect.objectContaining({ attemptId: offer.attemptId, nextAction: "continue the saved conversation" }));
    expect(before.continuation.resume).toEqual({ possible: true, runnerId: "runner-a" });

    const receipt = await run(w, "session.resume", "resume-1", { sessionId });
    const resumedId = receipt.resourceId!;
    expect(resumedId).not.toBe(sessionId);
    const resumed = await sessionOf(w, resumedId);
    // The new session says which checkpoint it started from, and where that was held.
    expect(resumed).toMatchObject({ mode: "managed", state: "starting", workItemId: before.workItemId, resumedFrom: { sessionId, checkpointDigest: before.checkpoint!.digest, runnerId: "runner-a" } });
    expect(resumed.checkpoint).toBeUndefined();
    // The old session is untouched: its checkpoint and its failure stay what they were.
    expect(await sessionOf(w, sessionId)).toMatchObject({ state: "failed", checkpoint: { digest: before.checkpoint!.digest } });

    // The new run's job is pinned: the explanation names every other runner as a mismatch, and the claim offers it to no one else.
    const job = w.brain.store.control.prepare("SELECT id FROM jobs WHERE state='queued' ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get() as { id: string };
    expect(await explained(w, job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runnerId: "runner-a", eligible: true }),
      expect.objectContaining({ runnerId: "runner-b", eligible: false, reasons: expect.arrayContaining(["runner-mismatch"]) }),
    ]));
    expect(w.brain.jobProtocol.claim(b, "claim-b")).toBeNull();
    const claimed = w.brain.jobProtocol.claim(a, "claim-a") as unknown as Offer;
    expect(claimed.jobId).toBe(job.id);
    expect(claimed.jobFence).toBe(1);
    expect(claimed.attemptId).not.toBe(offer.attemptId);
    // The pinned artifact carries the engine state to continue, and the earlier session it came from.
    const payload = JSON.parse(new TextDecoder().decode(w.brain.jobProtocol.executionArtifact(a, claimed.attemptId))) as { resume?: { engineState: { digest: string }; fromSessionId: string } };
    expect(payload.resume).toEqual({ engineState: before.checkpoint!.engineState, fromSessionId: sessionId });

    // Starting the attempt binds it to the resumed session, not a new one.
    w.brain.jobProtocol.ack(a, claimed.attemptId, { leaseId: claimed.leaseId, jobFence: claimed.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: FEATURES } });
    expect(await sessionOf(w, resumedId)).toMatchObject({ state: "running", attemptId: claimed.attemptId, resumedFrom: { sessionId } });
    expect((await sessions(w)).filter((entry) => entry.attemptId === claimed.attemptId)).toHaveLength(1);
  });

  it("is idempotent on the command, and refuses a second resume while the first run is going", async () => {
    const { w, sessionId } = await interrupted();
    const first = await run(w, "session.resume", "resume-twice", { sessionId });
    expect((await run(w, "session.resume", "resume-twice", { sessionId })).resourceId).toBe(first.resourceId);
    await expect(run(w, "session.resume", "resume-again", { sessionId })).rejects.toThrow(/already going/i);
    expect((await sessions(w)).filter((entry) => entry.resumedFrom)).toHaveLength(1);
  });

  it("is not offered, and says why, when the runner holding the checkpoint is offline", async () => {
    const { w, b, sessionId } = await interrupted();
    advance(120_000);
    // Only the other runner keeps answering; the holder went quiet.
    heartbeat(w, b);
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume.possible).toBe(false);
    expect(facts.resume.reason).toMatch(/runner-a holds this checkpoint and is offline/);
    expect(facts.resume.runnerId).toBe("runner-a");
    // The fresh start stays offered, and the refusal carries the same reason.
    expect(facts.restartable).toBe(true);
    await expect(run(w, "session.resume", "resume-offline", { sessionId })).rejects.toThrow(/runner-a holds this checkpoint and is offline/);
  });

  it("is not offered when the holding runner takes no work any more", async () => {
    const { w, sessionId } = await interrupted();
    await run(w, "runner.control", "disable-a", { runnerId: "runner-a", action: "disable", reason: "retired" });
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/runner-a holds this checkpoint but is disabled/) });
    await expect(run(w, "session.resume", "resume-disabled", { sessionId })).rejects.toThrow(/disabled/);
  });

  it("is not offered when the holding runner's engine no longer offers resume", async () => {
    const { w, a, sessionId } = await interrupted();
    // The holder says in its next heartbeat that its engine can no longer resume (the model it needs is not answering).
    heartbeat(w, a, ["sessions"]);
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, runnerId: "runner-a", reason: expect.stringMatching(/its fixture engine does not offer resume/) });
    // The same checkpoint is offered again as soon as the engine says it can resume.
    heartbeat(w, a);
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true, runnerId: "runner-a" });
  });

  it("offers nothing and says nothing when no checkpoint was saved, and refuses a checkpoint that saved no engine conversation", async () => {
    const none = await interrupted({ checkpoint: false });
    expect((await sessionOf(none.w, none.sessionId)).continuation.resume).toEqual({ possible: false });
    await expect(run(none.w, "session.resume", "resume-none", { sessionId: none.sessionId })).rejects.toThrow(/no checkpoint/i);
    closeWorlds();
    const stateless = await interrupted({ checkpoint: "no-state" });
    // A checkpoint with no engine state is not recorded as one at all: there is nothing a runner could continue from.
    expect((await sessionOf(stateless.w, stateless.sessionId)).continuation.resume).toEqual({ possible: false });
  });

  it("is refused while a fresh run of the same task is going, and says so", async () => {
    const { w, a, sessionId } = await interrupted();
    // The task was queued to retry; once its wait is over the Governor starts it again, and resuming as well would run the task twice.
    advance(600_000);
    heartbeat(w, a);
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get()).toEqual({ n: 1 });
    expect((await sessionOf(w, sessionId)).continuation.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/already going/) });
    await expect(run(w, "session.resume", "resume-busy", { sessionId })).rejects.toThrow(/already going/);
  });
});
