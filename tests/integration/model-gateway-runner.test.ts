import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { runAgentOnRoutes, selectEngine, type RouteCandidate } from "../../apps/runner/src/engines/run";
import { hostedRoutesOf } from "../../apps/runner/src/supervisor";
import { gatewayWorld, route, running, secondAttempt, set } from "../support/model-gateway";

// ADR 0072 at the runner's engine seam: a real Governor listens, the runner's real Pi engine calls it with the attempt's gateway token, and the
// fake vendor endpoint behind it is the only place the key ever arrives. The runner's own environment holds no model key at all.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); delete process.env["BRAIN_PI_AGENT_DIR"]; });

const REAL_KEY = "REAL-VENDOR-KEY-held-only-on-the-governor-host";
interface Vendor { url: string; requests: Array<{ authorization: string | undefined; model: string }> }

async function fakeVendor(behaviour: "quota" | "ok"): Promise<Vendor> {
  const requests: Vendor["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) as { model?: string } : {};
      requests.push({ authorization: req.headers.authorization, model: parsed.model ?? "" });
      if (behaviour === "quota") { res.writeHead(429, { "content-type": "application/json", "retry-after": "45" }); res.end(JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "OK" }, null));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe("a runner calls a model through the Governor's gateway without holding the key", () => {
  it("serves the step with the attempt's token, moves past a route whose account is out of quota, and never shows the runner the key", async () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("BRAIN_MODEL_KEY_")) delete process.env[name];
    const [a, b] = [await fakeVendor("quota"), await fakeVendor("ok")];
    const dirs: string[] = [];
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-gateway-e2e-")), allowTestActor: true });
    cleanups.push(() => app.close());
    const governor = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    cleanups.push(() => { governor.close(); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const governorUrl = `http://127.0.0.1:${(governor.address() as AddressInfo).port}`;

    // The Governor host holds the keys; the vendor addresses are https in the settings and reach the fakes through the Governor's model port.
    app.brain.modelKeyEnv = { BRAIN_MODEL_KEY_ACME_A: `${REAL_KEY}-a`, BRAIN_MODEL_KEY_ACME_B: `${REAL_KEY}-b` };
    const hosts: Record<string, string> = { "a.acme.example": a.url, "b.acme.example": b.url };
    app.brain.modelFetch = ((input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); return fetch(`${hosts[url.hostname]}${url.pathname}`, init); }) as typeof fetch;
    const w = gatewayWorld(dirs, app.brain);
    await set(w, "e-1", [route("a"), route("b")]);
    const job = await secondAttempt(w, "e1");
    const attempt = running(w, job.runner, "req-e1");
    // The runner's environment holds no model key: gatewayWorld set them only to stand in for the Governor host, which now reads its own.
    for (const name of ["BRAIN_MODEL_KEY_ACME_A", "BRAIN_MODEL_KEY_ACME_B"]) delete process.env[name];

    // What the runner does after its attempt starts: read the pinned routes, ask for the token, build one hosted route per gateway route.
    const pinned = (JSON.parse((w.brain.store.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(job.jobId) as { payload_json: string }).payload_json) as { modelRoutes: Parameters<typeof hostedRoutesOf>[0] }).modelRoutes;
    const client = new GovernorClient({ governorUrl });
    const routes = hostedRoutesOf(pinned, { baseUrl: (routeId) => client.gatewayBaseUrl(routeId), token: attempt.token });
    expect(routes.map((entry) => [entry.routeId, entry.baseUrl, entry.keyRef])).toEqual([["a", `${governorUrl}/model-gateway/v1/routes/a`, ""], ["b", `${governorUrl}/model-gateway/v1/routes/b`, ""]]);
    // Without a token no gateway route is usable at all.
    expect(hostedRoutesOf(pinned)).toEqual([]);

    const agentDir = mkdtempSync(join(tmpdir(), "brain-gateway-pi-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    process.env["BRAIN_PI_AGENT_DIR"] = agentDir;
    const candidates: RouteCandidate[] = routes.map((entry) => ({ route: entry, engine: new PiEngine([], entry) }));
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = await runAgentOnRoutes({
      attemptId: attempt.attemptId, jobFence: attempt.jobFence, leaseId: attempt.leaseId, runnerId: job.runner.runnerId, organizationId: w.org, workspaceId: w.workspaceId, jobId: job.jobId, configDigest: `sha256:${"0".repeat(64)}`,
      instructions: "Follow the task.", task: "Say OK.", timeoutMs: 60_000, maxTokens: 100_000, maxTurns: 4,
      emit: async (kind, payload) => { if (kind === "engine") events.push(payload as { kind: string; payload: Record<string, unknown> }); },
      signal: new AbortController().signal,
    }, candidates);

    expect(result.ok).toBe(true);
    expect(result.outputText.trim()).toBe("OK");
    expect(result.routes).toEqual([{ routeId: "a", outcome: "quota", retryAfterMs: 45_000 }, { routeId: "b", outcome: "served" }]);
    // The vendors received the Governor's keys and the routes' models, not the attempt's token.
    expect(a.requests).toEqual([{ authorization: `Bearer ${REAL_KEY}-a`, model: "model-a" }]);
    expect(b.requests).toEqual([{ authorization: `Bearer ${REAL_KEY}-b`, model: "model-b" }]);
    // Usage is priced with the serving route's prices: 1000 x $3/M + 100 x $15/M = $0.0045, and the gateway measured the same.
    expect(events.filter((event) => event.kind === "usage").at(-1)?.payload).toMatchObject({ inputTokens: 1000, outputTokens: 100, microUsd: 4_500 });
    const measured = w.brain.store.control.prepare("SELECT route_id AS routeId, outcome, input_tokens AS inputTokens, output_tokens AS outputTokens, micro_usd AS microUsd FROM model_gateway_calls ORDER BY at_ms, rowid").all();
    expect(measured).toEqual([{ routeId: "a", outcome: "quota", inputTokens: 0, outputTokens: 0, microUsd: 0 }, { routeId: "b", outcome: "served", inputTokens: 1000, outputTokens: 100, microUsd: 4_500 }]);
    // Nothing the runner wrote or held contains the key.
    const held: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else held.push(readFileSync(path).toString("utf8")); } };
    walk(agentDir);
    expect(held.length).toBeGreaterThan(0);
    for (const text of held) expect(text).not.toContain(REAL_KEY);

    // The attempt ends: the same token is refused by the live Governor.
    w.brain.jobProtocol.complete(job.runner, attempt.attemptId, { result: "succeeded", jobFence: attempt.jobFence, cleanupConfirmed: true, output: { ok: true }, modelRoutes: result.routes });
    const late = await fetch(`${governorUrl}/model-gateway/v1/routes/b/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${attempt.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [] }) });
    expect(late.status).toBe(401);
    expect(b.requests).toHaveLength(1);
  });

  it("offers a route through the gateway only to an engine that speaks its protocol", () => {
    const route = { routeId: "a", keyRef: "", baseUrl: "http://127.0.0.1:1/model-gateway/v1/routes/a", model: "model-a", inputMicroUsdPerMTok: 1, outputMicroUsdPerMTok: 1, gatewayToken: "bgw_x" };
    expect(selectEngine("claude", [], route)).toBeUndefined();
    expect(selectEngine("pi", [], route)?.id).toBe("pi");
    // A direct route and a claude engine are unchanged.
    expect(selectEngine("claude", [], { routeId: "a", keyRef: "acme-a", baseUrl: route.baseUrl, model: "model-a", inputMicroUsdPerMTok: 1, outputMicroUsdPerMTok: 1 })?.id).toBe("claude");
  });
});
