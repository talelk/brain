import { resolveModelKey, ROUTE_NAME } from "@brain/contracts";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { newId } from "../domain/clock";
import { BodyReader } from "../http/body";
import { markRouteQuota, modelRoutesOf, resolveGatewayToken, routeCooldownUntil, routeUsable, type GatewayGrant } from "../modules/jobs/index";

interface Ports {
  readonly store: Store;
  /** The network port for model calls: tests hand in a fake; the product uses the platform's fetch. */
  readonly modelFetch: () => typeof fetch;
  /** The environment of this host that route keys are read from (BRAIN_MODEL_KEY_<reference>); the product passes process.env. */
  readonly keyEnv: () => Readonly<Record<string, string | undefined>>;
  /** Whether the run's mission money or the workspace cap says a model call must stop (read-only). */
  readonly spendStopped: (organizationId: string, workspaceId: string, runId: string, inFlightMicroUsd: number) => boolean;
}

/** The largest request a runner may send through the gateway, the largest answer it relays and the longest a call may take. */
export const GATEWAY_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const GATEWAY_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const GATEWAY_CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_USAGE_LINE = 1024 * 1024;

type Outcome = "served" | "quota" | "failed" | "cancelled" | "refused";
interface Usage { inputTokens: number; outputTokens: number }

const refusal = (status: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: { message, type: status === 401 ? "invalid_api_key" : "gateway_refused", code: null } }), { status, headers: { "content-type": "application/json", ...headers } });

/** The token counts a model answer reports: OpenAI-compatible `usage` with prompt and completion tokens. */
function usageOf(value: unknown): Usage | undefined {
  const usage = value !== null && typeof value === "object" ? (value as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage : undefined;
  if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return undefined;
  return { inputTokens: Math.max(0, Math.round(usage.prompt_tokens)), outputTokens: Math.max(0, Math.round(usage.completion_tokens)) };
}

/**
 * The Governor's optional model gateway (ADR 0072). For a route the owner marked `viaGateway`, the runner calls this OpenAI-compatible endpoint
 * with its attempt's gateway token instead of calling the vendor with a key of its own. The Governor checks the token, that the route is one this
 * attempt was offered, that the route's account is not out of quota and that the mission's money and the workspace cap still allow a call, then
 * forwards to the route's upstream with the key held only on this host and relays the answer (a stream stays a stream). It keeps ids, status,
 * token counts, byte counts and the priced cost per call, never a request or an answer.
 */
export class ModelGateway {
  private readonly bodies = new BodyReader(64 * 1024 * 1024, 30_000);
  constructor(private readonly ports: Ports) {}

  async handle(request: Request, routeId: string): Promise<Response> {
    const { store } = this.ports;
    const started = Date.now();
    const bearer = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return refusal(401, "the model gateway needs the attempt's gateway token as a bearer credential");
    let grant: GatewayGrant;
    try { grant = resolveGatewayToken(store, bearer); } catch (error) {
      return refusal(401, error instanceof BrainDomainError ? error.message : "the model gateway token is refused");
    }
    const refuse = (status: number, message: string, route?: { model: string }, headers: Record<string, string> = {}, outcome: Outcome = "refused"): Response => {
      this.record(grant, { routeId, model: route?.model ?? "", status, outcome, usage: undefined, microUsd: 0, requestBytes: 0, responseBytes: 0, durationMs: Date.now() - started });
      return refusal(status, message, headers);
    };
    if (!ROUTE_NAME.test(routeId)) return refuse(403, "no such model route for this attempt");
    // Only a route this job was offered, that the owner still sends through the gateway and that is still complete and switched on.
    const pinned = this.pinnedRouteIds(grant.jobId);
    const route = pinned.has(routeId) ? modelRoutesOf(store, grant.workspaceId).find((candidate) => candidate.routeId === routeId) : undefined;
    if (!route || !route.viaGateway || !routeUsable(route)) return refuse(403, "no such model route for this attempt");
    const cooling = routeCooldownUntil(store, grant.workspaceId, routeId);
    if (cooling !== undefined) {
      const seconds = Math.max(1, Math.ceil((cooling - store.now()) / 1000));
      return refuse(429, `this model route's account is out of quota; try the next route in ${seconds}s`, route, { "retry-after": String(seconds) }, "quota");
    }
    const spentSoFar = (store.control.prepare("SELECT COALESCE(SUM(micro_usd),0) AS n FROM model_gateway_calls WHERE attempt_id=?").get(grant.attemptId) as { n: number }).n;
    if (this.ports.spendStopped(grant.organizationId, grant.workspaceId, grant.runId, spentSoFar)) return refuse(403, "the mission's money allowance or the workspace cap is used up; this call was not sent");
    const key = resolveModelKey(route.keyRef, this.ports.keyEnv());
    if (!key) return refuse(502, "the Governor holds no key for this model route; nothing was sent");

    let body: Record<string, unknown>;
    let requestBytes = 0;
    try {
      const raw = await this.bodies.read(request, GATEWAY_MAX_REQUEST_BYTES);
      requestBytes = raw.byteLength;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BrainDomainError && error.code === "PAYLOAD_TOO_LARGE") return refuse(413, "the request is larger than the model gateway takes");
      return refuse(400, "the request is not a JSON object");
    }
    // The route decides the model, and a stream always reports its token counts so the call can be priced.
    body["model"] = route.model;
    if (body["stream"] === true) body["stream_options"] = { ...(typeof body["stream_options"] === "object" && body["stream_options"] !== null ? body["stream_options"] as Record<string, unknown> : {}), include_usage: true };

    const abort = new AbortController();
    const onClientGone = (): void => abort.abort();
    request.signal.addEventListener("abort", onClientGone);
    const timer = setTimeout(() => abort.abort(), GATEWAY_CALL_TIMEOUT_MS);
    timer.unref?.();
    const finish = (status: number, outcome: Outcome, usage: Usage | undefined, responseBytes: number): void => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onClientGone);
      const microUsd = usage ? Math.ceil((usage.inputTokens * route.inputMicroUsdPerMTok + usage.outputTokens * route.outputMicroUsdPerMTok) / 1_000_000) : 0;
      this.record(grant, { routeId, model: route.model, status, outcome, usage, microUsd, requestBytes, responseBytes, durationMs: Date.now() - started });
    };

    let upstream: Response;
    try {
      upstream = await this.ports.modelFetch()(`${route.baseUrl}/chat/completions`, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    } catch {
      finish(502, abort.signal.aborted ? "cancelled" : "failed", undefined, 0);
      return refusal(502, "the model endpoint could not be reached");
    }

    if (upstream.status === 429) {
      // The account is out of quota: every later offer leaves this route out until the provider's wait has passed, and the runner moves to its next route.
      const seconds = Number(upstream.headers.get("retry-after"));
      markRouteQuota(store, grant.workspaceId, routeId, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined, "the provider refused for quota or rate");
    }
    const outcome: Outcome = upstream.status === 429 ? "quota" : upstream.ok ? "served" : "failed";
    const headers = new Headers();
    for (const name of ["content-type", "retry-after"]) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const reader = upstream.body?.getReader();
    if (!reader) { finish(upstream.status, outcome, undefined, 0); return new Response(null, { status: upstream.status, headers }); }

    // Relay chunk by chunk; look only for the token counts, keep nothing else.
    const decoder = new TextDecoder();
    let total = 0;
    let usage: Usage | undefined;
    let pending = "";
    let whole = "";
    let closed = false;
    const settle = (status: number, end: Outcome): void => { if (closed) return; closed = true; finish(status, end, usage, total); };
    const scan = (text: string, last: boolean): void => {
      if (streaming) {
        pending += text;
        const lines = pending.split("\n");
        pending = last ? "" : lines.pop() ?? "";
        if (pending.length > MAX_USAGE_LINE) pending = "";
        for (const line of lines) {
          if (!line.startsWith("data:") || !line.includes("\"usage\"")) continue;
          try { usage = usageOf(JSON.parse(line.slice(5).trim())) ?? usage; } catch { /* a partial or foreign line carries no counts */ }
        }
      } else if (whole.length <= GATEWAY_MAX_RESPONSE_BYTES) {
        whole += text;
        if (last) { try { usage = usageOf(JSON.parse(whole)); } catch { /* an error body carries no counts */ } whole = ""; }
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            scan(decoder.decode(), true);
            settle(upstream.status, outcome);
            controller.close();
            return;
          }
          total += chunk.value.byteLength;
          if (total > GATEWAY_MAX_RESPONSE_BYTES) { abort.abort(); settle(upstream.status, "failed"); controller.error(new Error("the model's answer is larger than the gateway relays")); return; }
          scan(decoder.decode(chunk.value, { stream: true }), false);
          controller.enqueue(chunk.value);
        } catch (error) {
          settle(upstream.status, abort.signal.aborted ? "cancelled" : "failed");
          controller.error(error);
        }
      },
      cancel() { abort.abort(); settle(upstream.status, "cancelled"); return reader.cancel().catch(() => undefined); },
    });
    return new Response(stream, { status: upstream.status, headers });
  }

  /** The routes the job was offered, pinned with its payload when it was first offered. */
  private pinnedRouteIds(jobId: string): Set<string> {
    const row = this.ports.store.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string } | undefined;
    try { return new Set(((JSON.parse(row?.payload_json ?? "{}") as { modelRoutes?: Array<{ routeId: string; viaGateway?: boolean }> }).modelRoutes ?? []).filter((route) => route.viaGateway === true).map((route) => route.routeId)); } catch { return new Set(); }
  }

  private record(grant: GatewayGrant, call: { routeId: string; model: string; status: number; outcome: Outcome; usage: Usage | undefined; microUsd: number; requestBytes: number; responseBytes: number; durationMs: number }): void {
    const { store } = this.ports;
    try {
      store.control.prepare(`INSERT INTO model_gateway_calls(id,organization_id,workspace_id,attempt_id,route_id,model,status,outcome,input_tokens,output_tokens,micro_usd,request_bytes,response_bytes,duration_ms,at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId("gwc"), grant.organizationId, grant.workspaceId, grant.attemptId, call.routeId, call.model, call.status, call.outcome,
        call.usage?.inputTokens ?? 0, call.usage?.outputTokens ?? 0, call.microUsd, call.requestBytes, call.responseBytes, call.durationMs, store.now());
    } catch { /* the Governor is closing; a call that cannot be recorded is not made to fail */ }
  }
}
