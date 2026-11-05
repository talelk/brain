import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import { GovernorClient, GovernorProtocolError } from "../../apps/runner/src/governor-client";
import { runOnce } from "../../apps/runner/src/supervisor";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";

interface FakeCall { method: string; path: string; body: unknown; auth: string | null }

type Scripted = number | { status: number; json?: unknown; bytes?: Uint8Array };

/** Scripted transport: responses keyed by `METHOD /path`, every call recorded. */
function fakeTransport(responses: Record<string, Scripted>, calls: FakeCall[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, auth: headers["authorization"] ?? null });
    const scripted = responses[`${method} ${url.pathname}`] ?? { status: 404, json: { error: `unscripted ${method} ${url.pathname}` } };
    if (typeof scripted === "number") return new Response(null, { status: scripted });
    if (scripted.bytes) return new Response(Buffer.from(scripted.bytes), { status: scripted.status });
    if (scripted.json !== undefined) return new Response(JSON.stringify(scripted.json), { status: scripted.status });
    return new Response(null, { status: scripted.status });
  };
}

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function clientWith(responses: Record<string, Scripted>, calls: FakeCall[] = []): GovernorClient {
  const client = new GovernorClient({ governorUrl: "http://governor.test", transport: fakeTransport(responses, calls) });
  client.setToken("tok-1");
  return client;
}

describe("GovernorClient protocol surface", () => {
  it("claim: 204 is no work (null), 200 is the typed offer, other statuses throw with status", async () => {
    const calls: FakeCall[] = [];
    const empty = clientWith({ "POST /runner/v1/claim": 204 }, calls);
    expect(await empty.claim("claim-1")).toBe(null);
    const offer = { attemptId: "at-1", jobId: "job-1", workspaceId: "ws-1", leaseId: "l-1", jobFence: 3, configDigest: DIGEST_A, execution: { kind: "tool", artifact: { artifactId: "art-1", digest: DIGEST_B, bytes: 7 } } };
    const busy = clientWith({ "POST /runner/v1/claim": { status: 200, json: offer } });
    expect((await busy.claim("claim-2"))?.attemptId).toBe("at-1");
    const broken = clientWith({ "POST /runner/v1/claim": { status: 500, json: { error: "boom" } } });
    await expect(broken.claim("claim-3")).rejects.toThrow(/claim failed 500/u);
    await expect(broken.claim("claim-3")).rejects.toMatchObject({ status: 500 });
    expect(calls.filter((c) => c.path === "/runner/v1/claim")).toHaveLength(1);
  });

  it("enroll/challenge/hello round-trip the handshake and carry the bearer token only after setToken", async () => {
    const calls: FakeCall[] = [];
    const client = new GovernorClient({ governorUrl: "http://governor.test/", transport: fakeTransport({
      "POST /runner/v1/enroll": { status: 201, json: { credential: "cred-1" } },
      "POST /runner/v1/challenges": { status: 201, json: { challengeId: "ch-1", nonce: "n-1" } },
      "POST /runner/v1/hello": { status: 200, json: { sessionToken: "sess-1", epoch: 4 } },
    }, calls) });
    expect(await client.enroll("enr-tok", "pub-pem", "runner-1")).toEqual({ credential: "cred-1" });
    expect(await client.challenge("runner-1", "cred-1")).toEqual({ challengeId: "ch-1", nonce: "n-1" });
    expect(await client.hello({ contractVersion: "brain.runner/v1" })).toEqual({ sessionToken: "sess-1", epoch: 4 });
    expect(calls.every((c) => c.auth === null)).toBe(true);
    client.setToken("sess-1");
    await client.heartbeat({ runnerId: "runner-1" }).catch(() => undefined);
    expect(calls.at(-1)!.auth).toBe("Bearer sess-1");
  });

  it("executionArtifact returns verified bytes and refuses tampered or oversized payloads", async () => {
    const bytes = new TextEncoder().encode('{"kind":"tool"}');
    const good = clientWith({ "GET /runner/v1/attempts/at-1/artifact": { status: 200, bytes } });
    expect(new TextDecoder().decode(await good.executionArtifact("at-1", sha256Digest(bytes), bytes.length))).toBe('{"kind":"tool"}');
    const tampered = clientWith({ "GET /runner/v1/attempts/at-1/artifact": { status: 200, bytes } });
    await expect(tampered.executionArtifact("at-1", DIGEST_A, bytes.length)).rejects.toThrow(/digest\/size mismatch; refusing to run/u);
    const oversized = clientWith({ "GET /runner/v1/attempts/at-1/artifact": { status: 200, bytes } });
    await expect(oversized.executionArtifact("at-1", sha256Digest(bytes), bytes.length + 1)).rejects.toThrow(/digest\/size mismatch/u);
    const dead = clientWith({ "GET /runner/v1/attempts/at-1/artifact": { status: 500, json: null } });
    await expect(dead.executionArtifact("at-1", DIGEST_A, 1)).rejects.toThrow(/execution artifact fetch failed 500/u);
  });

  it("agentInstructions verifies release identity and instruction digest before returning them", async () => {
    const instructions = new TextEncoder().encode("You are the starter agent.");
    const asset = {
      agent: { metadata: { id: "starter" }, spec: { instructionsPath: "instructions/starter.md", engine: { anyOf: ["fixture"] }, maxTurns: 4, maxTokens: 100, maxMicroUsd: 1, tools: [] } },
      agentDigest: DIGEST_A, path: "instructions/starter.md", instructionsDigest: sha256Digest(instructions),
      bytesBase64: Buffer.from(instructions).toString("base64"), toolBindings: [],
    };
    const good = clientWith({ "GET /runner/v1/releases/d/agents/starter/instructions": { status: 200, json: asset } });
    expect((await good.agentInstructions("d", "starter", DIGEST_A)).instructions).toBe("You are the starter agent.");
    const wrongId = clientWith({ "GET /runner/v1/releases/d/agents/starter/instructions": { status: 200, json: { ...asset, agentDigest: DIGEST_B } } });
    await expect(wrongId.agentInstructions("d", "starter", DIGEST_A)).rejects.toThrow(/identity does not match the job offer/u);
    const wrongDigest = clientWith({ "GET /runner/v1/releases/d/agents/starter/instructions": { status: 200, json: { ...asset, instructionsDigest: DIGEST_B } } });
    await expect(wrongDigest.agentInstructions("d", "starter", DIGEST_A)).rejects.toThrow(/instruction digest mismatch/u);
  });

  it("toolScript refuses scripts that disagree with the offer pin", async () => {
    const script = new TextEncoder().encode("#!/bin/bash\necho hi");
    const good = clientWith({ "GET /runner/v1/releases/d/tools/t-1": { status: 200, json: { entrypoint: "run.sh", entrypointDigest: sha256Digest(script), bytesBase64: Buffer.from(script).toString("base64") } } });
    expect(new TextDecoder().decode((await good.toolScript("d", "t-1", sha256Digest(script))).bytes)).toBe("#!/bin/bash\necho hi");
    const mismatch = clientWith({ "GET /runner/v1/releases/d/tools/t-1": { status: 200, json: { entrypoint: "run.sh", entrypointDigest: sha256Digest(script), bytesBase64: "eA==" } } });
    await expect(mismatch.toolScript("d", "t-1", DIGEST_A)).rejects.toThrow(/digest disagrees with the offer pin/u);
  });

  it("validatePermit reports any non-OK or invalid answer as false, never throws", async () => {
    expect(await clientWith({ "POST /runner/v1/permits/validate": { status: 200, json: { valid: true } } }).validatePermit("t", "inv-1")).toBe(true);
    expect(await clientWith({ "POST /runner/v1/permits/validate": { status: 200, json: { valid: false } } }).validatePermit("t", "inv-1")).toBe(false);
    expect(await clientWith({ "POST /runner/v1/permits/validate": { status: 403, json: { error: "expired" } } }).validatePermit("t", "inv-1")).toBe(false);
  });

  it("heartbeat 401 throws with status so the supervisor can flag the session stale", async () => {
    const calls: FakeCall[] = [];
    const client = clientWith({ "POST /runner/v1/heartbeat": 401 }, calls);
    const error = await client.heartbeat({ runnerId: "runner-1" }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(GovernorProtocolError);
    expect((error as GovernorProtocolError).status).toBe(401);
    expect(calls[0]!.auth).toBe("Bearer tok-1");
  });

  it("events 409/410 throw with the status the supervisor needs to discard a fenced journal", async () => {
    const client = clientWith({ "POST /runner/v1/attempts/at-1/events": { status: 409, json: { error: "fenced" } } });
    await expect(client.events("at-1", { events: [] })).rejects.toMatchObject({ status: 409 });
  });

  it("uploadArtifact computes the digest itself and completes/verdicts round-trip", async () => {
    const calls: FakeCall[] = [];
    const client = clientWith({
      "POST /runner/v1/attempts/at-1/artifacts": { status: 201, json: { artifactId: "art-9", digest: DIGEST_A, bytes: 5 } },
      "POST /runner/v1/attempts/at-1/complete": { status: 200, json: {} },
      "POST /runner/v1/verdicts": { status: 200, json: {} },
    }, calls);
    const bytes = new TextEncoder().encode("hello");
    expect(await client.uploadArtifact("at-1", bytes, "text/plain")).toEqual({ artifactId: "art-9", digest: DIGEST_A, bytes: 5 });
    const upload = calls.find((c) => c.path === "/runner/v1/attempts/at-1/artifacts")!;
    expect((upload.body as { digest: string }).digest).toBe(sha256Digest(bytes));
    await client.complete("at-1", { result: "succeeded" });
    await client.submitVerdict("ws-1", { contractVersion: "brain.verdict/v1", bundleDigest: DIGEST_A, evaluatorAttemptId: "at-2", evaluatorRelease: { id: "ev", digest: DIGEST_B }, independence: "L2", outcome: "verified", checks: [], acceptedBy: "runner-1", createdAt: new Date().toISOString() });
    const rejected = clientWith({ "POST /runner/v1/attempts/at-1/complete": { status: 409, json: { error: "fenced" } } });
    await expect(rejected.complete("at-1", { result: "succeeded" })).rejects.toThrow(/complete failed 409/u);
  });
});

describe("runOnce against a scripted Governor", () => {
  function scriptedOffer(): { offer: Record<string, unknown>; payloadBytes: Uint8Array } {
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ kind: "tool", input: { message: "hi" }, step: { uses: { type: "tool", release: { id: "absent.tool" } }, effectClass: "read" } }));
    return {
      payloadBytes,
      offer: {
        attemptId: "at-1", jobId: "job-1", workspaceId: "ws-1", leaseId: "lease-1", jobFence: 1,
        configDigest: `sha256:${"1".repeat(64)}`,
        execution: { kind: "tool", artifact: { artifactId: "art-in", digest: sha256Digest(payloadBytes), bytes: payloadBytes.length } },
      },
    };
  }

  it("drives claim → ack → artifact → events → complete without a live server and reports the failure outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-govclient-run-"));
    try {
      const { offer, payloadBytes } = scriptedOffer();
      const calls: FakeCall[] = [];
      const cfg: RunnerConfig = {
        governorUrl: "http://governor.test", runnerId: "runner-1", stateDir: root,
        capabilities: ["os:linux", "tool:fixture.echo"], engines: ["fixture"],
        transport: fakeTransport({
          "POST /runner/v1/claim": { status: 200, json: offer },
          "POST /runner/v1/attempts/at-1/ack": { status: 200, json: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } },
          "GET /runner/v1/attempts/at-1/artifact": { status: 200, bytes: payloadBytes },
          "POST /runner/v1/attempts/at-1/events": { status: 200, json: {} },
          "POST /runner/v1/attempts/at-1/complete": { status: 200, json: {} },
        }, calls),
      };
      await expect(runOnce(cfg, "tok-1")).resolves.toBe(true);
      const complete = calls.find((c) => c.path === "/runner/v1/attempts/at-1/complete");
      expect(complete).toBeDefined();
      expect((complete!.body as { result: string }).result).toBe("failed"); // tool script missing, lease intact
      expect(calls.filter((c) => c.path.endsWith("/events")).length).toBeGreaterThan(0);
      expect(calls.every((c) => c.auth === "Bearer tok-1")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("204 on claim means idle: no ack, no attempt, false", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-govclient-idle-"));
    try {
      const calls: FakeCall[] = [];
      const cfg: RunnerConfig = {
        governorUrl: "http://governor.test", runnerId: "runner-1", stateDir: root,
        capabilities: ["os:linux"], engines: ["fixture"],
        transport: fakeTransport({ "POST /runner/v1/claim": 204 }, calls),
      };
      await expect(runOnce(cfg, "tok-1")).resolves.toBe(false);
      expect(calls.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
