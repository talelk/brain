import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { domainDigest, type ActorContext, type CommandReceipt, type Delegation, type JsonValue } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";

// A delegation reached the way it happens: a running session of a mission asks for a child, then fixture runners run the child and its
// independent check. Only the Governor's own protocol and commands are used. Shared by the browser walkthrough and the visual baseline.

const DIGEST = `sha256:${"a".repeat(64)}`;
export interface Runner { runnerId: string; epoch: number; organizationId: string }
export interface Offer { jobId: string; attemptId: string; leaseId: string; jobFence: number }
export interface DelegationRunner { cfg: Parameters<typeof runOnce>[0]; sessionToken: string; epoch: number }

/** A runner that enrolls and says hello with the capabilities the real runner would, so the test claims by hand what a person's task started. */
export function registerRunner(brain: Brain, owner: ActorContext, runnerId: string): Runner {
  const protocol = brain.jobProtocol;
  const { token } = protocol.issueEnrollment(owner, "agents");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { credential } = protocol.enrollRunner({ token, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), runnerId });
  const challenge = protocol.challenge(runnerId, credential);
  const capabilities = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: ["sessions"] }])];
  const body: Record<string, unknown> = {
    contractVersion: "brain.runner/v1", runnerId, bootNonce: `boot-${runnerId}`, runtimeVersion: "test", configDigest: DIGEST,
    capacity: { cpuMillicores: 16000, memoryMb: 32768, diskMb: 40960, slots: 4 }, engines: [], isolationModes: ["ephemeral-container"],
    capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId: challenge.challengeId, nonce: challenge.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
  const { epoch } = protocol.hello({ ...body, proof: { challengeId: challenge.challengeId, signatureBase64url: sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url") } });
  return { runnerId, epoch, organizationId: owner.organizationId };
}

/** The runner takes the next job and starts its attempt: the session of that attempt is running. */
export function startAttempt(brain: Brain, runner: Runner, key: string): Offer {
  const offer = brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as Offer | null;
  if (!offer) throw new Error("no job was waiting for the runner");
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST, features: ["sessions"] } });
  return offer;
}

/** The identity the attempt's credential speaks for: its member's machine principal. */
export async function sessionIdentity(brain: Brain, runner: Runner, offer: Offer, workspaceId: string): Promise<ActorContext> {
  const { credential } = brain.jobProtocol.sessionCredential(runner, offer.attemptId);
  return (await brain.resolveActor(new Headers({ authorization: `Bearer ${credential}` }), workspaceId)).actor;
}

export async function delegateFrom(brain: Brain, actor: ActorContext, workspaceId: string, key: string, payload: Record<string, unknown>): Promise<CommandReceipt> {
  return (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "session.delegate", workspaceId, idempotencyKey: key, payload } as never, key)).receipt;
}

/** Fixture runners for the child's own attempts: one for the agent step, one for the independent check. */
export async function enrollChildRunners(brain: Brain, owner: ActorContext, governorUrl: string, prefix: string): Promise<DelegationRunner[]> {
  const sessions: DelegationRunner[] = [];
  for (const group of ["agents", "evaluators"]) {
    const cfg = { governorUrl, runnerId: `${prefix}-${group}`, stateDir: join(brain.store.dataDir, `${prefix}-${group}`), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const hello = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(owner, group).token);
    sessions.push({ cfg, sessionToken: hello.sessionToken, epoch: hello.epoch });
  }
  return sessions;
}

/** Lets the runners take every job the delegated children need until `until` holds. */
export async function driveChildren(runners: readonly DelegationRunner[], until: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("the delegated children did not finish in time");
    let worked = false;
    for (const runner of runners) worked = (await runOnce(runner.cfg, runner.sessionToken, runner.epoch)) || worked;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function delegationsOf(brain: Brain, actor: ActorContext, workspaceId: string, missionId?: string): Promise<Delegation[]> {
  return ((await brain.executeQuery(actor, { queryType: "delegations.list", workspaceId, ...(missionId ? { resourceId: missionId } : {}) } as never)) as unknown as { snapshot: { items: Delegation[] } }).snapshot.items;
}
