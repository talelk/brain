import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { domainDigest, type CommandReceipt, type JsonValue, type Mission } from "@brain/contracts";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";

// ADR 0035: placement requires the isolation a step sets from the engine that would run it, as the runner stated it at hello. Runners
// register through the runner protocol (enroll, challenge, signed hello); the work comes from a confirmed plan.

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

/** A started task: its step runs an agent on the `fixture` engine, in the `agents` runner group, with `ephemeral-container` isolation. */
async function startedTask(): Promise<{ w: World; jobId: string }> {
  const w = setupWorld();
  worlds.push(w);
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const missionId = (await run(w, "mission.create", "m-create", { title: "Isolation", intent: "Check placement", successCriteria: ["done"] })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", "m-plan", { missionId, origin: "manual", tasks: [{ id: "a", title: "Task a", criteria: ["a is done"], dependsOn: [] }] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as { snapshot: Mission }).snapshot.version;
  await run(w, "plan.confirm", "m-confirm", { planVersionId: planId }, version);
  const job = w.brain.store.control.prepare("SELECT id FROM jobs WHERE state='queued' ORDER BY created_at_ms LIMIT 1").get() as { id: string } | undefined;
  expect(job, "the confirmed task queued its first job").toBeDefined();
  return { w, jobId: job!.id };
}

/** A runner that enrolls and says hello with these capabilities, as the real runner does. */
function register(w: World, runnerId: string, capabilities: readonly string[]): { runnerId: string; epoch: number; organizationId: string } {
  const protocol = w.brain.jobProtocol;
  const { token } = protocol.issueEnrollment(w.owner, "agents");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { credential } = protocol.enrollRunner({ token, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), runnerId });
  const challenge = protocol.challenge(runnerId, credential);
  const body: Record<string, unknown> = {
    contractVersion: "brain.runner/v1", runnerId, bootNonce: `boot-${runnerId}`, runtimeVersion: "test", configDigest: DIGEST_A,
    capacity: { cpuMillicores: 16000, memoryMb: 32768, diskMb: 40960, slots: 4 }, engines: [], isolationModes: ["ephemeral-container"],
    capabilities: capabilities.map((capability) => ({ capability, verified: true, source: "runner-probe", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() })),
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId: challenge.challengeId, nonce: challenge.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
  const { epoch } = protocol.hello({ ...body, proof: { challengeId: challenge.challengeId, signatureBase64url: sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url") } });
  return { runnerId, epoch, organizationId: w.org };
}

const BASE = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"];
const ENGINE = ["engine:fixture", "engine-feature:fixture:sessions"];

const explained = async (w: World, jobId: string) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "job.explain", workspaceId: w.workspaceId, resourceId: jobId } as never)) as unknown as { snapshot: { primaryReason: string; runners: Array<{ runnerId: string; eligible: boolean; reasons: string[] }> } }).snapshot;

describe("placement and the isolation an engine provides (ADR 0035)", () => {
  it("offers the step to a runner whose engine states the step's isolation, and to no runner whose engine states a weaker one or none", async () => {
    const { w, jobId } = await startedTask();
    // What the real runner states for an engine without native tools, and what a runner states for an engine that runs in its own process space.
    const container = register(w, "runner-container", [...BASE, ...advertisedCapabilities([], [{ id: "fixture", features: ["sessions"] }])]);
    const local = register(w, "runner-trusted-local", [...BASE, ...ENGINE, "engine-isolation:fixture:trusted-local"]);
    const silent = register(w, "runner-silent", [...BASE, ...ENGINE]);

    const view = await explained(w, jobId);
    const verdict = (runnerId: string) => view.runners.find((runner) => runner.runnerId === runnerId)!;
    expect(verdict("runner-container")).toMatchObject({ eligible: true, reasons: [] });
    expect(verdict("runner-trusted-local")).toMatchObject({ eligible: false, reasons: ["isolation-mismatch"] });
    expect(verdict("runner-silent")).toMatchObject({ eligible: false, reasons: ["isolation-mismatch"] });

    // The claim agrees with the explanation: the runners that cannot meet the isolation are offered nothing, the one that can is offered the step.
    expect(w.brain.jobProtocol.claim(local, "claim-local")).toBeNull();
    expect(w.brain.jobProtocol.claim(silent, "claim-silent")).toBeNull();
    expect(w.brain.jobProtocol.claim(container, "claim-container")).toMatchObject({ jobId });
  });

  it("explains that nothing can take the step when the only runners with the engine cannot meet the isolation", async () => {
    const { w, jobId } = await startedTask();
    register(w, "runner-trusted-local", [...BASE, ...ENGINE, "engine-isolation:fixture:trusted-local"]);
    const view = await explained(w, jobId);
    expect(view.primaryReason).not.toBe("READY");
    expect(view.runners).toEqual([expect.objectContaining({ runnerId: "runner-trusted-local", eligible: false, reasons: ["isolation-mismatch"] })]);
  });
});
