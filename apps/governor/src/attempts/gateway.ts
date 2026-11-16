import { secretName, type AttemptUsage } from "@brain/contracts";
import type { Context } from "hono";
import type { Governor } from "../app";
import type { Gov } from "../dispatch";
import { markChanged } from "../events";
import { taskOf } from "../tasks/store";
import { readSecret } from "../trust/secrets";
import { capOf, meterUsage, microUsd, spentToday } from "../trust/usage";
import { activeManifest, manifestOf } from "../workspace/store";
import { attemptOfModelToken } from "./routes";

/**
 * The model gateway (docs/architecture.md section 6). An engine reaches its model only here, with the token of its attempt: OpenAI-style at
 * `/model/v1/chat/completions`, Anthropic-style at `/model/v1/messages`. The Governor forwards to the workspace's models of that kind in
 * order (the agent's own first), moves to the next when one refuses for quota or is not available, keeps the keys to itself, and adds the
 * token counts and cost each answer reports to the attempt's usage. It keeps no request and no answer.
 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const CALL_TIMEOUT_MS = 10 * 60_000;
type Provider = "openai-compatible" | "anthropic";
const refusal = (status: number, message: string): Response => Response.json({ error: { message, type: status === 401 ? "invalid_api_key" : "gateway_refused", code: null } }, { status });

/** Adds to `into` what one JSON answer (or one frame of a stream) says about usage, in either vendor's words. */
export function readUsage(value: unknown, into: AttemptUsage): AttemptUsage {
  const holder = value as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } } | null;
  const usage = holder?.usage ?? holder?.message?.usage;
  if (!usage || typeof usage !== "object") return into;
  const count = (name: string): number | undefined => (typeof usage[name] === "number" ? Math.max(0, Math.round(usage[name])) : undefined);
  const next = { ...into };
  const cached = (usage["prompt_tokens_details"] as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  if (count("prompt_tokens") !== undefined) Object.assign(next, { inputTokens: count("prompt_tokens"), outputTokens: count("completion_tokens") ?? next.outputTokens, cachedInputTokens: typeof cached === "number" ? cached : next.cachedInputTokens });
  if (count("input_tokens") !== undefined) Object.assign(next, { inputTokens: (count("input_tokens") ?? 0) + (count("cache_read_input_tokens") ?? 0) + (count("cache_creation_input_tokens") ?? 0), cachedInputTokens: count("cache_read_input_tokens") ?? 0 });
  if (count("output_tokens") !== undefined) next.outputTokens = count("output_tokens") ?? 0;
  // A model server that prices its own calls says so in `usage.cost`, in dollars.
  if (typeof usage["cost"] === "number") next.microUsd = Math.round(usage["cost"] * 1_000_000);
  return next;
}

async function forward(gov: Gov, c: Context, provider: Provider): Promise<Response> {
  const request = c.req.raw;
  const token = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? request.headers.get("x-api-key") ?? "";
  const attempt = attemptOfModelToken(gov, token);
  if (!attempt) return refusal(401, "The model token is not valid: its attempt is not running any more");
  const manifest = manifestOf(gov, taskOf(gov.db, attempt.task_id).snapshot_digest);
  // The gateway itself holds the two money limits, because an engine may report no cost at all.
  const cap = capOf(activeManifest(gov, attempt.workspace_id));
  if (cap > 0 && spentToday(gov, attempt.workspace_id) >= cap) return refusal(403, "The workspace's daily spend cap is used up; this call was not sent");
  const agent = manifest.agents[attempt.agent];
  const limit = microUsd(agent?.limits.spend_usd ?? 0);
  const used = (gov.db.prepare("SELECT metered_micro_usd AS n FROM usage WHERE attempt_id=?").get(attempt.id) as { n: number } | undefined)?.n ?? 0;
  if (limit > 0 && used >= limit) return refusal(403, "This attempt has used up its agent's spend limit; this call was not sent");
  const preferred = agent?.model;
  const models = manifest.models.filter((model) => model.provider === provider).sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred));
  if (models.length === 0) return refusal(404, `This workspace has no ${provider} model`);
  const raw = new Uint8Array(await request.arrayBuffer());
  let call: Record<string, unknown>;
  try {
    call = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (raw.length > MAX_REQUEST_BYTES || call === null || typeof call !== "object" || Array.isArray(call)) throw new Error("not an object");
  } catch {
    return refusal(400, "The request is not a JSON object the gateway takes");
  }
  // A stream always reports its token counts, so the call can be recorded.
  if (provider === "openai-compatible" && call["stream"] === true) call["stream_options"] = { ...(call["stream_options"] as object | undefined), include_usage: true };

  let last = refusal(502, "No model of this workspace could be reached");
  for (const model of models) {
    const key = model.key ? readSecret(gov, attempt.workspace_id, secretName(model.key)) : undefined;
    if (model.key && key === undefined) {
      last = refusal(502, `The secret ${secretName(model.key)} of the model ${model.name} is not set`);
      continue;
    }
    const base = model.url.replace(/\/+$/u, "");
    const url = provider === "anthropic" ? `${base.replace(/\/v1$/u, "")}/v1/messages` : `${base}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" };
    if (provider === "anthropic") Object.assign(headers, { "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01", ...(key ? { "x-api-key": key } : {}), ...(request.headers.get("anthropic-beta") ? { "anthropic-beta": request.headers.get("anthropic-beta") } : {}) });
    else if (key) headers["authorization"] = `Bearer ${key}`;
    const abort = AbortSignal.any([request.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
    let upstream: Response;
    try {
      upstream = await gov.fetch(url, { method: "POST", headers, body: JSON.stringify({ ...call, model: model.model }), signal: abort, redirect: "error" });
    } catch {
      last = refusal(502, `The model ${model.name} could not be reached`);
      continue;
    }
    // Out of quota, rate limited or down: the next model of the workspace is tried.
    if (upstream.status === 402 || upstream.status === 429 || upstream.status >= 500) {
      last = new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
      continue;
    }
    return relay(gov, upstream, attempt.id, attempt.workspace_id, model.name);
  }
  return last;
}

/** Hands the model's answer on as it arrives, reading only its usage figures on the way. */
function relay(gov: Gov, upstream: Response, attemptId: string, workspaceId: string, model: string): Response {
  const headers = new Headers();
  for (const name of ["content-type", "retry-after"]) if (upstream.headers.get(name)) headers.set(name, upstream.headers.get(name) as string);
  const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const decoder = new TextDecoder();
  let used: AttemptUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 };
  let pending = "";
  const scan = (text: string, end: boolean): void => {
    pending += text;
    const frames = streaming ? pending.split("\n") : end ? [pending] : [];
    if (streaming) pending = end ? "" : (frames.pop() ?? "");
    for (const frame of frames) {
      const data = streaming ? (frame.startsWith("data:") && frame.includes("\"usage\"") ? frame.slice(5) : undefined) : frame;
      if (data === undefined) continue;
      try { used = readUsage(JSON.parse(data), used); } catch { /* not JSON: it carries no figures */ }
    }
  };
  let recorded = false;
  const record = (): void => {
    if (recorded) return;
    recorded = true;
    scan(decoder.decode(), true);
    if (upstream.ok && gov.db.open) {
      meterUsage(gov.db, attemptId, model, used);
      markChanged(gov.db, workspaceId);
    }
  };
  const reader = upstream.body?.getReader();
  if (!reader) return new Response(null, { status: upstream.status, headers });
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          record();
          return controller.close();
        }
        scan(decoder.decode(chunk.value, { stream: true }), false);
        controller.enqueue(chunk.value);
      } catch (e) {
        record();
        controller.error(e);
      }
    },
    cancel() {
      record();
      return reader.cancel().catch(() => undefined);
    },
  }), { status: upstream.status, headers });
}

export function registerGateway({ gov, app }: Governor): void {
  app.post("/model/v1/chat/completions", (c) => forward(gov, c, "openai-compatible"));
  app.post("/model/v1/messages", (c) => forward(gov, c, "anthropic"));
}
