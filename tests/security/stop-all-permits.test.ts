import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { fixtureGate } from "../../apps/runner/src/engines/fixture";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

/**
 * Stop all sessions (ADR 0045) against effect permits: a permit that was issued and never used dies with its attempt, and an effect that had
 * already started is never claimed cancelled: its attempt is left "outcome unknown" for a person to settle.
 */
let world: EffectsWorld | undefined;
afterEach(() => { delete fixtureGate.hold; });
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

const toolDigest = (id: string): string => sha256Digest(new TextEncoder().encode(fixtureStarter().documents.find((doc) => doc.path === `config/${id}.yaml`)!.text));
const call = (container: string) => ({ proposalId: `proposal-${container}`, tool: { id: "host.restart", digest: toolDigest("host.restart") }, input: { container } });

async function liveAttempt(w: EffectsWorld, key: string): Promise<{ attemptId: string; finish: () => Promise<void> }> {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let entered!: (attemptId: string) => void;
  const enteredAttempt = new Promise<string>((resolve) => { entered = resolve; });
  fixtureGate.hold = async (attemptId) => { entered(attemptId); await opened; };
  await w.dispatch(key, []);
  const running = w.run();
  const attemptId = await enteredAttempt;
  return { attemptId, finish: async () => { open(); await running; } };
}

/** The held job of an approved change, taken as a runner attempt that holds an issued permit for it. */
async function heldWithPermit(w: EffectsWorld, key: string, container: string): Promise<{ attemptId: string; permit: { token: string; invocationId: string }; offer: { attemptId: string; leaseId: string; jobFence: number } }> {
  const proposer = await liveAttempt(w, key);
  const proposed = w.w.brain.requestEffect(w.runner, proposer.attemptId, call(container)) as unknown as { approvalId: string };
  await w.decide(w.store.control.prepare("SELECT id, subject_digest, version FROM approval_requests WHERE id=?").get(proposed.approvalId) as { id: string; subject_digest: string; version: number }, "approve");
  await proposer.finish();
  const offer = w.w.brain.jobProtocol.claim(w.runner, `claim-${key}`) as unknown as { attemptId: string; leaseId: string; jobFence: number };
  expect(offer).toBeTruthy();
  w.w.brain.jobProtocol.ack(w.runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "tool-broker", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] } });
  const permit = w.w.brain.issueEffectPermit(w.runner, offer.attemptId, call(container)) as unknown as { token: string; invocationId: string };
  return { attemptId: offer.attemptId, permit, offer };
}

async function stopAll(w: EffectsWorld, key: string): Promise<void> {
  const reason = "Emergency stop";
  const headers = new Headers({ authorization: `Bearer ${w.w.ownerToken}` });
  const identity = await w.w.brain.resolveActor(headers, w.w.workspaceId);
  const challenge = w.w.brain.stepUp.createCommandChallenge(identity, { commandType: "workspace.sessions.stopAll", workspaceId: w.w.workspaceId, payload: { workspaceId: w.w.workspaceId, reason } });
  const evidence = await w.w.brain.stepUp.verifyCommand(identity, challenge.challengeId, "", headers);
  const { receipt } = await w.w.brain.executeCommand(w.w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workspace.sessions.stopAll", workspaceId: w.w.workspaceId, idempotencyKey: key,
    payload: { workspaceId: w.w.workspaceId, reason, stepUpEvidenceId: evidence.evidenceId } } as never, key, headers);
  expect(receipt.accepted).toBe(true);
}

describe("stop all sessions and effect permits", () => {
  it("revokes a permit that was issued and not used: it cannot start the call, and the held change is cancelled", async () => {
    world = await effectsWorld({ containers: ["demo-app", "other-app"] });
    const w = world;
    const held = await heldWithPermit(w, "stop-1", "demo-app");
    expect(w.w.brain.validatePermit(held.permit.token, held.permit.invocationId)).toBe(true);

    await stopAll(w, "stop-permit-1");

    expect(w.w.brain.validatePermit(held.permit.token, held.permit.invocationId)).toBe(false);
    expect(w.permits()).toEqual([expect.objectContaining({ invocation_id: held.permit.invocationId, state: "revoked" })]);
    expect(() => w.w.brain.startEffect(w.runner, held.attemptId, { ...call("demo-app"), token: held.permit.token })).toThrow(/fenced|lease/u);
    expect(() => w.w.brain.issueEffectPermit(w.runner, held.attemptId, call("demo-app"))).toThrow(/fenced|lease/u);
    expect(() => w.w.brain.jobProtocol.renew(w.runner, held.attemptId, { leaseId: held.offer.leaseId, jobFence: held.offer.jobFence })).toThrow(/fenced/u);
    expect(w.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(held.attemptId)).toEqual({ state: "cancelled" });
    // Nothing ran at the launcher.
    expect(w.restarts()).toEqual([]);
  }, scaled(120_000));

  it("never calls an effect that had started cancelled: its attempt is left outcome unknown for a person, and its permit cannot be used again", async () => {
    const w = world!;
    const held = await heldWithPermit(w, "stop-2", "other-app");
    w.w.brain.startEffect(w.runner, held.attemptId, { ...call("other-app"), token: held.permit.token });
    expect(w.permits().find((permit) => permit.invocation_id === held.permit.invocationId)?.state).toBe("started");

    await stopAll(w, "stop-permit-2");

    expect(w.w.brain.validatePermit(held.permit.token, held.permit.invocationId)).toBe(false);
    expect(w.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(held.attemptId)).toEqual({ state: "outcome_unknown" });
    expect(w.store.control.prepare("SELECT state FROM jobs WHERE id=(SELECT job_id FROM job_attempts WHERE id=?)").get(held.attemptId)).toEqual({ state: "outcome_unknown" });
    expect(() => w.w.brain.finishEffect(w.runner, held.attemptId, { invocationId: held.permit.invocationId, outcome: "applied" })).toThrow(/fenced|lease/u);
    // The person is asked to check before anything goes on.
    const items = ((await w.w.brain.executeQuery(w.w.owner, { queryType: "attention.list", workspaceId: w.w.workspaceId })) as unknown as { snapshot: { items: Array<{ kind: string }> } }).snapshot.items;
    expect(items.map((item) => item.kind)).toContain("outcome-unknown");
  }, scaled(120_000));
});
