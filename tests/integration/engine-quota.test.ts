import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { engineFailureDetail, quotaRetryAfterMs } from "../../apps/runner/src/engines/failure-detail";

// ADR 0033: a provider's 429 or quota text is said to be that (the engine's failure detail leads with "quota or rate limit" and the wait the provider
// named), never "the model could not be reached", and the attempt ends at the first refusal instead of asking the same closed door again.
// Driven through the real Pi engine against a fake model endpoint.

const DIGEST = `sha256:${"0".repeat(64)}`;
const spec = (attemptId: string): EngineSessionSpec => ({
  contractVersion: "brain.engine/v1", organizationId: "org-q", workspaceId: "ws-q", dispatchId: "d-q", jobId: `job-${attemptId}`, attemptId, runnerId: "runner-q",
  runnerEpoch: 1, leaseId: "lease-q", jobFence: 1, engine: { id: "pi", version: "1.4.0", adapterDigest: DIGEST, features: ["sessions"] },
  modelId: "acme-large", instructions: "Follow the task.", instructionsDigest: DIGEST, task: "Say OK.", sourceRevision: `sha256:${"1".repeat(64)}`, configDigest: DIGEST,
  allowedTools: [], context: { artifactId: "ctx-q", digest: DIGEST, bytes: 0, mediaType: "application/json", classification: "internal" },
  limits: { timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 4 },
} as EngineSessionSpec);

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); delete process.env["BRAIN_PI_AGENT_DIR"]; delete process.env["BRAIN_LOCAL_MODEL_URL"]; });

/** An OpenAI-compatible endpoint that refuses every request the same way, and counts the requests it was sent. */
async function refusing(status: number, headers: Record<string, string>, body: unknown): Promise<{ requests: () => number }> {
  let count = 0;
  const server: Server = createServer((req, res) => { req.resume(); req.on("end", () => { count++; res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "brain-quota-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env["BRAIN_PI_AGENT_DIR"] = dir;
  process.env["BRAIN_LOCAL_MODEL_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { requests: () => count };
}

async function failedAttempt(): Promise<{ events: EngineEvent[]; error: string }> {
  const engine = new PiEngine([]);
  const { sessionId } = await engine.start(spec("att-q"), new AbortController().signal);
  const events: EngineEvent[] = [];
  for await (const event of engine.events(sessionId, 0, new AbortController().signal)) events.push(event);
  await engine.cancel(sessionId);
  const failure = events.find((event) => event.kind === "error");
  return { events, error: failure?.kind === "error" ? failure.payload.error.detail : "" };
}

const quotaBody = { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } };

describe("a provider that refuses for quota or rate (ADR 0033)", () => {
  it("a 429 with a Retry-After header ends the attempt at once: said as a quota, with the wait the provider named, after one request", async () => {
    const model = await refusing(429, { "retry-after": "45" }, quotaBody);
    const { events, error } = await failedAttempt();
    expect(error).toMatch(/^quota or rate limit \(retry after 45s\): /u);
    expect(error).not.toMatch(/^model endpoint/u);
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "error" } });
    expect(model.requests()).toBe(1);
  }, 60_000);

  it("a 429 whose body names the wait is said with that wait, and is not asked again in place", async () => {
    const model = await refusing(429, {}, { error: { message: "Rate limit reached for acme-large: 30000 tokens per min. Please try again in 1m30s.", type: "tokens", code: "rate_limit_exceeded" } });
    const { error } = await failedAttempt();
    expect(error).toMatch(/^quota or rate limit \(retry after 90s\): /u);
    // Pi cannot see a delay named only in the body, so it makes its one quick provider retry; the session's own three retries are cut short.
    expect(model.requests()).toBeLessThanOrEqual(2);
  }, 60_000);

  it("a 429 that names no wait still says quota, and carries no invented wait", async () => {
    await refusing(429, {}, quotaBody);
    const { error } = await failedAttempt();
    expect(error).toMatch(/^quota or rate limit: /u);
  }, 60_000);

  it("a server error is still a model endpoint failure, not a quota", async () => {
    await refusing(503, {}, { error: { message: "service unavailable" } });
    const { error } = await failedAttempt();
    expect(error).toMatch(/^model endpoint: /u);
  }, 60_000);
});

describe("how the provider's words are read", () => {
  it("reads headers and phrases into milliseconds, and nothing when no wait was named", () => {
    expect(quotaRetryAfterMs("Server requested 30s retry delay (max: 1s). 429: slow down")).toBe(30_000);
    expect(quotaRetryAfterMs("429 Retry-After: 12")).toBe(12_000);
    expect(quotaRetryAfterMs("Please try again in 6m0s.")).toBe(360_000);
    expect(quotaRetryAfterMs("Please retry in 24.5s")).toBe(24_500);
    expect(quotaRetryAfterMs("retry after 500ms")).toBe(500);
    expect(quotaRetryAfterMs("429 too many requests")).toBeUndefined();
  });

  it("leads the failure detail with the quota cause, and leaves other causes alone", () => {
    expect(engineFailureDetail("429: too many requests")).toBe("quota or rate limit: 429: too many requests");
    expect(engineFailureDetail("RESOURCE_EXHAUSTED: quota exceeded. Please retry in 20s")).toMatch(/^quota or rate limit \(retry after 20s\): /u);
    expect(engineFailureDetail("503 service unavailable")).toBe("model endpoint: 503 service unavailable");
    expect(engineFailureDetail("400 This model's maximum context length is 262144 tokens")).toMatch(/^context overflow: /u);
  });
});
