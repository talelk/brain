import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiEngine, type HostedRoute } from "../../apps/runner/src/engines/pi";
import { runAgentOnRoutes, type RouteCandidate } from "../../apps/runner/src/engines/run";

// ADR 0055 at the runner's engine seam: the Governor offers an attempt several model routes in order. A route whose provider answers 429 is
// left behind at once (never retried in place) and the next route takes the step; what the attempt reports names the route that served it
// and the ones it moved past. Driven through the real Pi engine against fake OpenAI-compatible endpoints.

const DIGEST = `sha256:${"0".repeat(64)}`;

interface Fake { server: Server; url: string; requests: Array<{ authorization: string | undefined; model: string }> }

/** An endpoint that refuses every request with 429 and a Retry-After, or answers "OK" with a fixed token usage. */
async function fakeEndpoint(behaviour: "quota" | "ok"): Promise<Fake> {
  const requests: Fake["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) as { model?: string } : {};
      requests.push({ authorization: req.headers.authorization, model: parsed.model ?? "" });
      if (behaviour === "quota") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "45" });
        res.end(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan", type: "insufficient_quota", code: "insufficient_quota" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "OK" }, null));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const cleanups: Array<() => void> = [];
const KEYS = ["BRAIN_MODEL_KEY_ACME_A", "BRAIN_MODEL_KEY_ACME_B", "BRAIN_PI_AGENT_DIR"];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); for (const key of KEYS) delete process.env[key]; });

const route = (routeId: string, baseUrl: string, model: string): HostedRoute => ({ routeId, keyRef: `acme-${routeId}`, baseUrl, model, inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 });

async function attempt(routes: HostedRoute[]) {
  const dir = mkdtempSync(join(tmpdir(), "brain-route-failover-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env["BRAIN_PI_AGENT_DIR"] = dir;
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const candidates: RouteCandidate[] = routes.map((entry) => ({ route: entry, engine: new PiEngine([], entry) }));
  const result = await runAgentOnRoutes({
    attemptId: "att-failover", jobFence: 1, leaseId: "lease", runnerId: "runner", organizationId: "org", workspaceId: "ws", jobId: "job-failover", configDigest: DIGEST,
    instructions: "Follow the task.", task: "Say OK.", timeoutMs: 60_000, maxTokens: 100_000, maxTurns: 4,
    emit: async (kind, payload) => { if (kind === "engine") events.push(payload as { kind: string; payload: Record<string, unknown> }); },
    signal: new AbortController().signal,
  }, candidates);
  return { result, usage: events.filter((event) => event.kind === "usage").map((event) => event.payload) };
}

describe("a quota refusal moves the attempt to the next route (ADR 0055)", () => {
  it("leaves a route that answers 429 behind without retrying it, serves the step from the second route and says which served", async () => {
    const [a, b] = [await fakeEndpoint("quota"), await fakeEndpoint("ok")];
    cleanups.push(() => a.server.close(), () => b.server.close());
    process.env["BRAIN_MODEL_KEY_ACME_A"] = "key-for-route-a"; process.env["BRAIN_MODEL_KEY_ACME_B"] = "key-for-route-b";
    const { result, usage } = await attempt([route("a", a.url, "model-a"), route("b", b.url, "model-b")]);
    expect(result.ok).toBe(true);
    expect(result.outputText.trim()).toBe("OK");
    // The refused route was asked exactly once, with its own key; the second route got the step with its own key and model.
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0]).toMatchObject({ authorization: "Bearer key-for-route-a", model: "model-a" });
    expect(b.requests[0]).toMatchObject({ authorization: "Bearer key-for-route-b", model: "model-b" });
    // The report names the route that was passed and the one that served, with the provider's own wait.
    expect(result.routes).toEqual([{ routeId: "a", outcome: "quota", retryAfterMs: 45_000 }, { routeId: "b", outcome: "served" }]);
    // Priced with the serving route's prices: 1000 x $3/M + 100 x $15/M = $0.0045.
    expect(usage.at(-1)).toMatchObject({ inputTokens: 1000, outputTokens: 100, microUsd: 4_500 });
    // A refusal that reached no model is not charged an estimate of tokens nobody used.
    expect(usage.some((entry) => entry["estimated"] === true)).toBe(false);
  });

  it("skips a route this runner holds no key for, and ends with the last refusal when every route refuses", async () => {
    const [a, b] = [await fakeEndpoint("quota"), await fakeEndpoint("quota")];
    cleanups.push(() => a.server.close(), () => b.server.close());
    // No key for route a at all: nothing is sent to it.
    process.env["BRAIN_MODEL_KEY_ACME_B"] = "key-for-route-b";
    const skipped = await attempt([route("a", a.url, "model-a"), route("b", b.url, "model-b")]);
    expect(a.requests).toHaveLength(0);
    expect(skipped.result.ok).toBe(false);
    expect(skipped.result.routes).toEqual([{ routeId: "a", outcome: "failed" }, { routeId: "b", outcome: "quota", retryAfterMs: 45_000 }]);
    process.env["BRAIN_MODEL_KEY_ACME_A"] = "key-for-route-a";
    const refused = await attempt([route("a", a.url, "model-a"), route("b", b.url, "model-b")]);
    expect(refused.result.ok).toBe(false);
    expect(refused.result.routes.map((entry) => entry.outcome)).toEqual(["quota", "quota"]);
    expect(JSON.stringify(refused.result.output)).toMatch(/quota or rate limit/);
    // Each route was asked once for this attempt: no blind retry anywhere.
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(2);
  });
});
