import { generateKeyPairSync, sign } from "node:crypto";
// Relative: the browser project resolves no workspace packages from tests/.
import { domainDigest, type ActorContext, type JsonValue } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { signCompletions, useRunnerKey } from "./signed-completion";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** What a runner says in its hello: the engines it reports and the capabilities it observed, each dated by the runner. */
export interface HelloReport {
  engines?: unknown;
  capabilities?: unknown;
}

export const observation = (capability: string, observedAt: string, extra: Record<string, unknown> = {}) => ({
  capability,
  observedAt,
  source: "runner-probe",
  verified: true,
  expiresAt: new Date(Date.parse(observedAt) + 300_000).toISOString(),
  ...extra,
});

/** A runner that enrolls and says a signed hello through the runner protocol (enroll, challenge, hello), as the real runner does. */
export function registerRunner(
  brain: Brain,
  actor: ActorContext,
  runnerId: string,
  report: HelloReport = {},
  group = "agents",
): { runnerId: string; epoch: number } {
  const protocol = brain.jobProtocol;
  const { token } = protocol.issueEnrollment(actor, group);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const { credential } = protocol.enrollRunner({ token, publicKeyPem, runnerId });
  // This runner signs the receipts of the attempts it completes with the key it just enrolled.
  signCompletions(brain);
  useRunnerKey(brain, runnerId, { publicKeyPem, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const challenge = protocol.challenge(runnerId, credential);
  const body: Record<string, unknown> = {
    contractVersion: "brain.runner/v1",
    runnerId,
    bootNonce: `boot-${runnerId}`,
    runtimeVersion: "test",
    configDigest: DIGEST,
    capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 2 },
    isolationModes: ["ephemeral-container"],
    engines: report.engines ?? [],
    capabilities: report.capabilities ?? [observation("os:linux", new Date(Date.now() - 60_000).toISOString())],
  };
  const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
  const signed = JSON.stringify({ challengeId: challenge.challengeId, nonce: challenge.nonce, runnerId, bootNonce: body["bootNonce"], helloDigest });
  const { epoch } = protocol.hello({
    ...body,
    proof: { challengeId: challenge.challengeId, signatureBase64url: sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url") },
  });
  return { runnerId, epoch };
}
