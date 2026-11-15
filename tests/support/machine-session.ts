import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { domainDigest, type CommandReceipt, type JsonValue, type Mission, type PlanTask, type TeamMember } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "./starter";

// A mission whose task is claimed by an enrolled runner, so its attempt can hold a session credential (ADR 0032, 0041). State is reached
// through commands and the runner protocol, never through table writes.

export type World = ReturnType<typeof setupWorld>;
export type Runner = { runnerId: string; epoch: number; organizationId: string };
export type Offer = { jobId: string; attemptId: string; leaseId: string; jobFence: number };

let now = Date.now();
export const clock = { nowMs: () => now, monotonicMs: () => now };
/** Moves the Governor's clock forward (a lease lapses, a credential expires). */
export const advance = (ms: number): void => { now += ms; };
export const currentTimeMs = (): number => now;

const dirs: string[] = [];
const worlds: World[] = [];
/** Closes every world this file's tests opened and removes their data; call from afterEach. */
export function closeWorlds(): void {
  for (const w of worlds.splice(0)) w.brain.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
export const missionOf = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
export const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is done`], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" }, ...extra });

/** A runner that enrolls and says hello with these capabilities, as the real runner does. */
export function register(w: World, runnerId: string): Runner {
  const protocol = w.brain.jobProtocol;
  const { token } = protocol.issueEnrollment(w.owner, "agents");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { credential } = protocol.enrollRunner({ token, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), runnerId });
  const challenge = protocol.challenge(runnerId, credential);
  const capabilities = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: ["sessions"] }])];
  const body: Record<string, unknown> = {
    contractVersion: "brain.runner/v1", runnerId, bootNonce: `boot-${runnerId}`, runtimeVersion: "test", configDigest: DIGEST_A,
    capacity: { cpuMillicores: 16000, memoryMb: 32768, diskMb: 40960, slots: 4 }, engines: [], isolationModes: ["ephemeral-container"],
    capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString() })),
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId: challenge.challengeId, nonce: challenge.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
  const { epoch } = protocol.hello({ ...body, proof: { challengeId: challenge.challengeId, signatureBase64url: sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url") } });
  return { runnerId, epoch, organizationId: w.org };
}

/** Stages and activates the fixture starter release, whose agents run on the fixture engine. */
export function stageStarter(w: World, bundle: ReturnType<typeof fixtureStarter> = fixtureStarter()): void {
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
}

/**
 * A confirmed mission whose tasks are assigned to team members: auto-start dispatches each ready one as its member's principal. By default
 * one task "a" for the member "pi" and no declared team; give `team` to name members a message can reach.
 */
export async function confirmedMission(w: World, options: { tasks?: PlanTask[]; team?: TeamMember[]; autonomy?: "supervised" | "standard" | "autonomous"; budget?: Record<string, number> } = {}): Promise<{ missionId: string; workItemId: string }> {
  const missionId = (await run(w, "mission.create", "m-create", { title: "Principals", intent: "Check who acts", successCriteria: ["done"], ...(options.autonomy ? { autonomy: options.autonomy } : {}), ...(options.budget ? { budget: options.budget } : {}) })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", "m-plan", { missionId, origin: "manual", tasks: options.tasks ?? [task("a")], ...(options.team ? { team: options.team } : {}) })).resourceId ?? "";
  await run(w, "plan.confirm", "m-confirm", { planVersionId: planId }, (await missionOf(w, missionId)).version);
  const workItemId = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM work_items WHERE mission_id=? ORDER BY rowid LIMIT 1").get(missionId) as { id: string }).id;
  return { missionId, workItemId };
}

/** A world with its own Governor on a controllable clock, the starter staged, a confirmed mission and an enrolled runner. */
export async function startedMission(options: Parameters<typeof confirmedMission>[1] & { starter?: ReturnType<typeof fixtureStarter> } = {}): Promise<{ w: World; missionId: string; runner: Runner; workItemId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-session-principal-"));
  dirs.push(dir);
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock }));
  worlds.push(w);
  stageStarter(w, options.starter);
  return { w, ...(await confirmedMission(w, options)), runner: register(w, "runner-principal") };
}

/** The runner claims the next job and starts its attempt; the attempt is running and holds its lease. */
export function running(w: World, runner: Runner, key: string): Offer {
  const offer = w.brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as Offer;
  expect(offer, "the runner was offered the task").toBeTruthy();
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: ["sessions"] } });
  return offer;
}

export const bearer = (credential: string) => new Headers({ authorization: `Bearer ${credential}` });
export const command = (w: World, commandType: string, key: string, payload: Record<string, unknown>, workspaceId = w.workspaceId) =>
  ({ contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId, idempotencyKey: key, payload }) as never;
