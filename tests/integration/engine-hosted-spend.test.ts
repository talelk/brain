import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { PiEngine, type HostedRoute } from "../../apps/runner/src/engines/pi";
import { hostedRoutesOf } from "../../apps/runner/src/supervisor";
import { overAllowanceReason, wrapUpReason } from "../../apps/runner/src/engines/limits";

// ADR 0023: hosted spend is real. The runner prices an attempt on the hosted route with the prices the Governor handed it (tokens x price),
// so the usage it reports reaches the mission and workspace dollar caps. Driven through the real Pi engine against a fake model endpoint.

const DIGEST = `sha256:${"0".repeat(64)}`;
const spec = (attemptId: string): EngineSessionSpec => ({
  contractVersion: "brain.engine/v1", organizationId: "org-h", workspaceId: "ws-h", dispatchId: "d-h", jobId: `job-${attemptId}`, attemptId, runnerId: "runner-h",
  runnerEpoch: 1, leaseId: "lease-h", jobFence: 1, engine: { id: "pi", version: "1.4.0", adapterDigest: DIGEST, features: ["sessions"] },
  modelId: "acme-large", instructions: "Follow the task.", instructionsDigest: DIGEST, task: "Say OK.", sourceRevision: `sha256:${"1".repeat(64)}`, worktreeId: "wt-h", configDigest: DIGEST,
  allowedTools: [], context: { artifactId: "ctx-h", digest: DIGEST, bytes: 0, mediaType: "application/json", classification: "internal" },
  limits: { timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 4 },
} as EngineSessionSpec);

/** An OpenAI-compatible endpoint that answers every request with one short message and a fixed token usage, and remembers what it was asked. */
async function fakeModel(usage: { prompt: number; completion: number }): Promise<{ server: Server; url: string; requests: Array<{ path: string; authorization: string | undefined; model: string }> }> {
  const requests: Array<{ path: string; authorization: string | undefined; model: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) as { model?: string } : {};
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, model: parsed.model ?? "" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "OK" }, null));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  delete process.env["BRAIN_PI_AGENT_DIR"]; delete process.env["BRAIN_MODEL_KEY_ACME_MAIN"];
});

async function runAttempt(route: HostedRoute | undefined, usage: { prompt: number; completion: number }, attemptId: string) {
  const model = await fakeModel(usage);
  cleanups.push(() => model.server.close());
  const dir = mkdtempSync(join(tmpdir(), "brain-hosted-spend-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env["BRAIN_PI_AGENT_DIR"] = dir;
  process.env["BRAIN_MODEL_KEY_ACME_MAIN"] = "hosted-key-for-tests";
  process.env["BRAIN_LOCAL_MODEL_URL"] = model.url;
  cleanups.push(() => { delete process.env["BRAIN_LOCAL_MODEL_URL"]; });
  const engine = new PiEngine([], route ? { ...route, baseUrl: model.url } : undefined);
  const { sessionId } = await engine.start(spec(attemptId), new AbortController().signal);
  const events: EngineEvent[] = [];
  for await (const event of engine.events(sessionId, 0, new AbortController().signal)) events.push(event);
  await engine.cancel(sessionId);
  const usageEvent = events.find((event) => event.kind === "usage")?.payload as { inputTokens: number; outputTokens: number; microUsd: number } | undefined;
  return { events, usage: usageEvent, requests: model.requests };
}

describe("an attempt on the hosted route records what it cost (ADR 0023)", () => {
  const route: HostedRoute = { routeId: "acme", keyRef: "acme-main", baseUrl: "https://models.acme.example/v1", model: "acme-large", inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 };

  it("reports non-zero spend equal to tokens x the route's prices", async () => {
    const { usage, requests, events } = await runAttempt(route, { prompt: 20_000, completion: 3_000 }, "att-priced");
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed" } });
    // The call went to the routed address with the runner's hosted key and model.
    expect(requests[0]).toMatchObject({ path: expect.stringContaining("/chat/completions"), authorization: "Bearer hosted-key-for-tests", model: "acme-large" });
    expect(usage).toMatchObject({ inputTokens: 20_000, outputTokens: 3_000 });
    // 20,000 x $3/M + 3,000 x $15/M = $0.105.
    expect(usage!.microUsd).toBe(105_000);
  });

  it("rounds a fraction of a micro-dollar up, never down to free", async () => {
    const { usage } = await runAttempt({ ...route, inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000 }, { prompt: 11, completion: 3 }, "att-tiny");
    expect(usage!.microUsd).toBe(4);
  });

  it("an attempt without a route stays free: the self-hosted model costs no dollars", async () => {
    const { usage } = await runAttempt(undefined, { prompt: 20_000, completion: 3_000 }, "att-local");
    expect(usage).toMatchObject({ inputTokens: 20_000, outputTokens: 3_000, microUsd: 0 });
  });
});

describe("hosted dollars meet the attempt's own allowance", () => {
  const use = { tokens: 1_000, microUsd: 50_000, turns: 1 };
  it("an agent with no dollar cap of its own is not stopped by hosted spend, and one with a cap is stopped at it", () => {
    expect(wrapUpReason(use, { maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 })).toBeUndefined();
    expect(overAllowanceReason(use, { maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 })).toBeUndefined();
    expect(wrapUpReason(use, { maxTokens: 100_000, maxMicroUsd: 60_000, maxTurns: 30 })).toBeDefined();
    expect(overAllowanceReason({ ...use, microUsd: 60_001 }, { maxTokens: 100_000, maxMicroUsd: 60_000, maxTurns: 30 })).toContain("micro-dollars");
  });
});

describe("the route reaches the engine with its prices", () => {
  const base = { tier: "hosted", role: "second-attempt", routeId: "acme", keyRef: "acme-main", baseUrl: "https://models.acme.example/v1", model: "acme-large" };
  it("is read from the job's model routes, and a route without both prices is not a route", () => {
    const full = { ...base, inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 };
    expect(hostedRoutesOf([full])).toEqual([{ routeId: "acme", keyRef: "acme-main", baseUrl: base.baseUrl, model: base.model, inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 }]);
    expect(hostedRoutesOf([{ ...base, inputMicroUsdPerMTok: 3_000_000 }])).toEqual([]);
    expect(hostedRoutesOf([{ ...base, inputMicroUsdPerMTok: 0, outputMicroUsdPerMTok: 15_000_000 }])).toEqual([]);
  });
});
