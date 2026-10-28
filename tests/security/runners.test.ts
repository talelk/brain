import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { domainDigest, type JsonValue } from "@brain/contracts";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// T15 packet acceptance: one-use enrollment, authenticated hello with
// monotonic epochs, and verified-observation boundaries (a hello can never
// elevate its own trust).
function enrolled(w: TestWorld, runnerId = "runner-sec"): { credential: string; privateKey: KeyObject; hello: (bootNonce: string, mutate?: (b: Record<string, unknown>) => void) => { sessionToken: string; epoch: number } } {
  const { token } = w.brain.issueEnrollment(w.owner, "fixture-tools");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const { credential } = w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId });
  const hello = (bootNonce: string, mutate?: (b: Record<string, unknown>) => void) => {
    const chal = w.brain.runnerChallenge(runnerId, credential);
    const body: Record<string, unknown> = {
      contractVersion: "brain.runner/v1", runnerId, bootNonce, configDigest: DIGEST_A,
      capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 },
      capabilities: [{ capability: "os:linux", verified: true, source: "runner-probe" }, { capability: "privileged:root", verified: true, source: "hello" }],
    };
    mutate?.(body);
    const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
    const signed = JSON.stringify({ challengeId: chal.challengeId, nonce: chal.nonce, runnerId, bootNonce, helloDigest });
    const signatureBase64url = sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url");
    return w.brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url } });
  };
  return { credential, privateKey, hello };
}

describe("runner enrollment and hello security (T15)", () => {
  it("enrollment tokens are single-use and scope-gated", () => {
    const w = setupWorld();
    const intruder = w.actor("mallory", w.workspaceId);
    expect(() => w.brain.issueEnrollment(intruder, "fixture-tools")).toThrow(/runner:admin/);
    const { token } = w.brain.issueEnrollment(w.owner, "fixture-tools");
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId: "runner-once" });
    expect(() => w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId: "runner-replay" })).toThrow(/replayed|invalid/);
    expect(() => w.brain.enrollRunner({ token: "bogus", publicKeyPem: pem, runnerId: "runner-bogus" })).toThrow();
    expect(() => w.brain.enrollRunner({ token: w.brain.issueEnrollment(w.owner, "fixture-tools").token, publicKeyPem: "not-a-pem", runnerId: "runner-x" })).toThrow(/PEM/);
    w.brain.close();
  });

  it("hello requires a fresh signed challenge; replays and forgeries fail", () => {
    const w = setupWorld();
    const { credential, privateKey, hello } = enrolled(w);
    const first = hello("boot-1");
    expect(first.epoch).toBe(1);
    // Wrong key: sign with a different keypair.
    const chal = w.brain.runnerChallenge("runner-sec", credential);
    const body: Record<string, unknown> = {
      contractVersion: "brain.runner/v1", runnerId: "runner-sec", bootNonce: "boot-1", configDigest: DIGEST_A,
      capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 }, capabilities: [],
    };
    const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
    const signed = JSON.stringify({ challengeId: chal.challengeId, nonce: chal.nonce, runnerId: "runner-sec", bootNonce: "boot-1", helloDigest });
    const forged = sign(null, Buffer.from(signed, "utf8"), generateKeyPairSync("ed25519").privateKey).toString("base64url");
    expect(() => w.brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url: forged } })).toThrow(/proof/);
    // Challenge replay: a consumed challenge cannot be reused even well-signed.
    const good = sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url");
    w.brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url: good } });
    expect(() => w.brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url: good } })).toThrow(/replayed|invalid/);
    w.brain.close();
  });

  it("epochs are monotonic per boot; old sessions die on reboot; hello cannot self-elevate trust", () => {
    const w = setupWorld();
    const { hello } = enrolled(w);
    const s1 = hello("boot-A");
    const s1b = hello("boot-A");
    expect(s1b.epoch).toBe(s1.epoch);
    const s2 = hello("boot-B");
    expect(s2.epoch).toBe(s1.epoch + 1);
    // Old-epoch session token no longer authenticates.
    expect(() => w.brain.authRunner(new Headers({ authorization: `Bearer ${s1.sessionToken}` }))).toThrow();
    expect(w.brain.authRunner(new Headers({ authorization: `Bearer ${s2.sessionToken}` })).epoch).toBe(s2.epoch);
    // Privileged capability self-assertions are stored unverified.
    const cap = w.brain.store.control.prepare("SELECT verified FROM runner_capabilities WHERE runner_id='runner-sec' AND capability='privileged:root'").get() as { verified: number };
    expect(cap.verified).toBe(0);
    // Quarantined runners cannot hello at all.
    w.brain.store.control.prepare("UPDATE runners SET admin_state='quarantined' WHERE id='runner-sec'").run();
    expect(() => hello("boot-C")).toThrow(/quarantined/);
    w.brain.close();
  });
});
