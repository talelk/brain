import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { domainDigest, sha256Digest, type JsonValue, type SessionDetail } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { DIGEST_A, setupWorld } from "../helpers";
import { advance, clock, closeWorlds, confirmedMission, run, stageStarter, task, type Offer, type Runner, type World } from "../support/machine-session";

// ADR 0068 (builds on 0045): a session's checkpoint is an artifact of the Governor, so a new session resumes it in a new run whose continuing
// step any eligible runner may claim and then download. The control is offered only when it can work. State is reached through commands and the
// runner protocol, never through table writes (the one exception tampers with stored bytes, which no command can do).

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
  const capabilities = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: [...features] }], false)];
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

const conversationOf = (offer: Offer): Uint8Array => new TextEncoder().encode(`{"type":"session","id":"${offer.attemptId}"}\n{"role":"user","content":"remember ZEPHYR-42"}\n`);

/** What the engine saved: its conversation, uploaded to the Governor by the runner while the attempt is still running. */
function checkpointOf(w: World, runner: Runner, offer: Offer, withEngineState = true): Record<string, unknown> {
  const bytes = conversationOf(offer);
  const stored = w.brain.acceptAttemptArtifact(runner, offer.attemptId, { digest: sha256Digest(bytes), bytesBase64: Buffer.from(bytes).toString("base64"), mediaType: "application/x-ndjson" });
  return {
    contractVersion: "brain.checkpoint/v2", attemptId: offer.attemptId, sourceRevision: DIGEST_A,
    ...(withEngineState ? { engineState: { artifactId: stored.artifactId, digest: stored.digest, bytes: stored.bytes, mediaType: "application/x-ndjson", classification: "internal" } } : {}),
    completedCriteria: [], failures: [], eventSequence: 0, ownedResources: [], nextAction: "continue the saved conversation", createdAt: new Date(clock.nowMs()).toISOString(),
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
  const capabilities = ["os:linux", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: [...features] }], false)];
  w.brain.jobProtocol.heartbeat(runner, { sequence: ++beat, health: "healthy", capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: at, expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString() })) });
}

const bytesOf = (data: Uint8Array) => Buffer.from(data).toString();
const sessions = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "sessions.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: SessionDetail[] } }).snapshot.items;
const sessionOf = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: SessionDetail }).snapshot;

/** A mission whose one task a runner started and failed, leaving a checkpoint; the world's clock is the test's. */
async function interrupted(options: { checkpoint?: boolean | "no-state" | "forged"; engineFeatures?: readonly string[] } = {}): Promise<{ w: World; a: Runner; b: Runner; sessionId: string; offer: Offer; workItemId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-session-resume-"));
  dirs.push(dir);
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock }));
  stageStarter(w);
  const { workItemId } = await confirmedMission(w, { tasks: [task("a")] });
  const a = register(w, "runner-a", options.engineFeatures);
  const b = register(w, "runner-b", options.engineFeatures);
  const offer = started(w, a, "first");
  const saved = options.checkpoint === false ? undefined : checkpointOf(w, a, offer, options.checkpoint !== "no-state");
  // A forged checkpoint names the uploaded artifact with a digest that is not its own.
  if (options.checkpoint === "forged" && saved) (saved["engineState"] as { digest: string }).digest = sha256Digest(new TextEncoder().encode("something else"));
  failedWith(w, a, offer, saved);
  const ended = (await sessions(w)).find((entry) => entry.attemptId === offer.attemptId);
  expect(ended, "the attempt's session exists").toBeDefined();
  return { w, a, b, sessionId: ended!.sessionId, offer, workItemId };
}

describe("resuming a session from its checkpoint (ADR 0068)", () => {
  it("resumes on a runner other than the one that took the checkpoint, once the holder is gone", async () => {
    const { w, a, b, sessionId, offer } = await interrupted();
    const before = await sessionOf(w, sessionId);
    expect(before.state).toBe("failed");
    expect(before.checkpoint).toEqual(expect.objectContaining({ attemptId: offer.attemptId, nextAction: "continue the saved conversation" }));
    expect(before.continuation.resume).toEqual({ possible: true });

    // The runner that took the checkpoint leaves the fleet: the checkpoint is the Governor's, so nothing is lost.
    await run(w, "runner.control", "retire-a", { runnerId: "runner-a", action: "deregister", reason: "retired" });
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true });

    const receipt = await run(w, "session.resume", "resume-1", { sessionId });
    const resumedId = receipt.resourceId!;
    expect(resumedId).not.toBe(sessionId);
    const resumed = await sessionOf(w, resumedId);
    // The new session says which checkpoint it started from; it names no runner, since whichever claims the step decides where it runs.
    expect(resumed).toMatchObject({ mode: "managed", state: "starting", workItemId: before.workItemId, resumedFrom: { sessionId, checkpointDigest: before.checkpoint!.digest } });
    expect(resumed.resumedFrom).not.toHaveProperty("runnerId");
    expect(resumed.checkpoint).toBeUndefined();
    // The old session is untouched: its checkpoint and its failure stay what they were.
    expect(await sessionOf(w, sessionId)).toMatchObject({ state: "failed", checkpoint: { digest: before.checkpoint!.digest } });

    // The new run's job is pinned to nobody: the other runner claims it, a new attempt with a new fence.
    const claimed = w.brain.jobProtocol.claim(b, "claim-b") as unknown as Offer;
    expect(claimed).toBeTruthy();
    expect(claimed.jobFence).toBe(1);
    expect(claimed.attemptId).not.toBe(offer.attemptId);
    // The pinned artifact carries the engine state to continue, and the earlier session it came from.
    const payload = JSON.parse(new TextDecoder().decode(w.brain.jobProtocol.executionArtifact(b, claimed.attemptId))) as { resume?: { engineState: { digest: string }; fromSessionId: string } };
    expect(payload.resume).toEqual({ engineState: before.checkpoint!.engineState, fromSessionId: sessionId });
    // The claiming runner downloads the saved conversation from the Governor: the very bytes the first runner uploaded.
    expect(bytesOf(w.brain.jobProtocol.resumeCheckpoint(b, claimed.attemptId))).toBe(bytesOf(conversationOf(offer)));
    void a;

    // Starting the attempt binds it to the resumed session, not a new one.
    w.brain.jobProtocol.ack(b, claimed.attemptId, { leaseId: claimed.leaseId, jobFence: claimed.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: FEATURES } });
    expect(await sessionOf(w, resumedId)).toMatchObject({ state: "running", attemptId: claimed.attemptId, resumedFrom: { sessionId } });
    expect((await sessions(w)).filter((entry) => entry.attemptId === claimed.attemptId)).toHaveLength(1);
  });

  it("serves the checkpoint only to the runner holding the attempt that resumes it", async () => {
    const { w, a, b, sessionId, offer } = await interrupted();
    await run(w, "session.resume", "resume-dl", { sessionId });
    const claimed = w.brain.jobProtocol.claim(a, "claim-a") as unknown as Offer;
    w.brain.jobProtocol.ack(a, claimed.attemptId, { leaseId: claimed.leaseId, jobFence: claimed.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: FEATURES } });
    // Another runner cannot read it through this attempt, and an attempt that resumes nothing has none to serve.
    expect(() => w.brain.jobProtocol.resumeCheckpoint(b, claimed.attemptId)).toThrow(/another runner/);
    expect(() => w.brain.jobProtocol.resumeCheckpoint(a, offer.attemptId)).toThrow();
    expect(bytesOf(w.brain.jobProtocol.resumeCheckpoint(a, claimed.attemptId))).toBe(bytesOf(conversationOf(offer)));
  });

  it("is idempotent on the command, and refuses a second resume while the first run is going", async () => {
    const { w, sessionId } = await interrupted();
    const first = await run(w, "session.resume", "resume-twice", { sessionId });
    expect((await run(w, "session.resume", "resume-twice", { sessionId })).resourceId).toBe(first.resourceId);
    await expect(run(w, "session.resume", "resume-again", { sessionId })).rejects.toThrow(/already going/i);
    expect((await sessions(w)).filter((entry) => entry.resumedFrom)).toHaveLength(1);
  });

  it("is still offered while the holder is offline, as long as another runner is eligible", async () => {
    const { w, b, sessionId } = await interrupted();
    advance(120_000);
    // Only the other runner keeps answering; the holder went quiet.
    heartbeat(w, b);
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true });
    await run(w, "session.resume", "resume-offline-holder", { sessionId });
    expect(w.brain.jobProtocol.claim(b, "claim-b")).toBeTruthy();
  });

  it("says plainly that no eligible runner exists, and still leaves the fresh start", async () => {
    const { w, b, sessionId } = await interrupted();
    advance(120_000);
    // Neither runner answers any more.
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/No runner is online and taking work/) });
    expect(facts.resume).not.toHaveProperty("runnerId");
    expect(facts.restartable).toBe(true);
    await expect(run(w, "session.resume", "resume-nobody", { sessionId })).rejects.toThrow(/No runner is online and taking work/);
    // One answers again, and the same checkpoint is offered.
    heartbeat(w, b);
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true });
  });

  it("is not offered when no runner is registered", async () => {
    const { w, sessionId } = await interrupted();
    await run(w, "runner.control", "retire-a", { runnerId: "runner-a", action: "deregister", reason: "retired" });
    await run(w, "runner.control", "retire-b", { runnerId: "runner-b", action: "deregister", reason: "retired" });
    expect((await sessionOf(w, sessionId)).continuation.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/No runner is registered/) });
  });

  it("is not offered when no runner takes work any more", async () => {
    const { w, sessionId } = await interrupted();
    await run(w, "runner.control", "disable-a", { runnerId: "runner-a", action: "disable", reason: "retired" });
    await run(w, "runner.control", "disable-b", { runnerId: "runner-b", action: "disable", reason: "retired" });
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/No runner is online and taking work/) });
    await expect(run(w, "session.resume", "resume-disabled", { sessionId })).rejects.toThrow(/taking work/);
  });

  it("is not offered when no runner advertises resume for the engine, and is offered again when one does", async () => {
    const { w, a, b, sessionId } = await interrupted();
    // Both runners say in their next heartbeat that the engine can no longer resume (the model it needs is not answering).
    heartbeat(w, a, ["sessions"]);
    heartbeat(w, b, ["sessions"]);
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/offers resume for the fixture engine/) });
    heartbeat(w, b);
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true });
  });

  it("does not record an engine state that is not an artifact this attempt uploaded, and one that was tampered with is refused", async () => {
    const forged = await interrupted({ checkpoint: "forged" });
    // The runner named bytes it never uploaded (here: someone else's digest): there is no checkpoint to resume from.
    expect((await sessionOf(forged.w, forged.sessionId)).checkpoint).toBeUndefined();
    expect((await sessionOf(forged.w, forged.sessionId)).continuation.resume).toEqual({ possible: false });
    closeWorlds();

    const { w, a, b, sessionId, offer } = await interrupted();
    expect((await sessionOf(w, sessionId)).continuation.resume).toEqual({ possible: true });
    // The stored bytes change on disk: the digest no longer matches, so nothing is offered and a resume is refused with the reason.
    const digest = (await sessionOf(w, sessionId)).checkpoint!.engineState!.digest;
    writeFileSync(casFilePath(w.brain.store, digest), "tampered");
    const facts = (await sessionOf(w, sessionId)).continuation;
    expect(facts.resume).toMatchObject({ possible: false, reason: expect.stringMatching(/no longer stored/) });
    await expect(run(w, "session.resume", "resume-tampered", { sessionId })).rejects.toThrow(/no longer stored/);
    void a; void b; void offer;
  });

  it("offers nothing and says nothing when no checkpoint was saved, and records no checkpoint that saved no engine conversation", async () => {
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
