import { createHmac } from "node:crypto";
import { BrainDomainError } from "../../domain/errors";

/**
 * Outbound connectors behind ports (ADR 0024): a ticketing system and a team chat (Slack or Teams). Credentials are server settings read
 * here and never reach a model, an event or an artifact; the model sees only the result (a ticket id and link, "delivered"). A port is
 * what the effect tools call after a person approved that exact call.
 */
export interface TicketRequest { readonly title: string; readonly description: string; readonly priority: string }
export interface TicketResult { readonly id: string; readonly url: string }
export interface TicketPort { create(request: TicketRequest): Promise<TicketResult> }
export interface MessagePort { send(text: string): Promise<{ delivered: true }> }

export interface WebhookEndpoint { readonly url: string; readonly secret?: string; readonly token?: string }

/** An https address (or http to this machine only), never with embedded credentials: the only places a server setting may send to. */
export function safeEndpoint(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password) return undefined;
  return url;
}

/** `X-Brain-Signature: sha256=<hmac of the body>`, the same signing the notification webhook uses. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function ticketEndpoint(env: NodeJS.ProcessEnv = process.env): WebhookEndpoint | undefined {
  const url = safeEndpoint(env["BRAIN_TICKET_WEBHOOK_URL"]);
  if (!url) return undefined;
  const secret = env["BRAIN_TICKET_WEBHOOK_SECRET"];
  const token = env["BRAIN_TICKET_WEBHOOK_TOKEN"];
  return { url: url.toString(), ...(secret ? { secret } : {}), ...(token ? { token } : {}) };
}

/**
 * A generic create-ticket adapter: POST {title, description, priority, source} as JSON to the configured address, signed and/or with a
 * bearer token, and read `{id | key | number, url}` from the answer. Any ticketing system with a REST or automation endpoint fits.
 */
export class WebhookTicketAdapter implements TicketPort {
  constructor(private readonly endpoint: WebhookEndpoint, private readonly fetchImpl: typeof fetch = fetch) {}

  async create(request: TicketRequest): Promise<TicketResult> {
    const body = JSON.stringify({ title: request.title, description: request.description, priority: request.priority, source: "brain" });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.endpoint.secret) headers["x-brain-signature"] = signBody(this.endpoint.secret, body);
    if (this.endpoint.token) headers["authorization"] = `Bearer ${this.endpoint.token}`;
    const response = await this.fetchImpl(this.endpoint.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new BrainDomainError("INTERNAL_ERROR", `the ticketing system answered ${response.status}`);
    const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
    const id = String(answer["id"] ?? answer["key"] ?? answer["number"] ?? "");
    if (!id) throw new BrainDomainError("INTERNAL_ERROR", "the ticketing system did not say which ticket it created");
    return { id: id.slice(0, 120), url: typeof answer["url"] === "string" ? answer["url"].slice(0, 500) : "" };
  }
}

export type ChatFormat = "generic" | "slack" | "teams";

export function chatFormat(env: NodeJS.ProcessEnv = process.env): ChatFormat {
  const value = env["BRAIN_NOTIFY_WEBHOOK_FORMAT"];
  return value === "slack" || value === "teams" ? value : "generic";
}

/** The body a chat product accepts: Slack takes `{text}`, Teams (Workflows webhook) takes an Adaptive Card message; generic keeps Brain's own shape. */
export function chatBody(format: ChatFormat, text: string, link?: string): Record<string, unknown> {
  if (format === "slack") return { text: link ? `${text}\n<${link}|Open in Brain>` : text };
  if (format === "teams") {
    return {
      type: "message",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [{ type: "TextBlock", text, wrap: true }],
        ...(link ? { actions: [{ type: "Action.OpenUrl", title: "Open in Brain", url: link }] } : {}),
      } }],
    };
  }
  return { type: "brain.notification", kind: "message", text, ...(link ? { link } : {}) };
}

/** Team chat through the server's webhook (Slack, Teams or generic), signed when a secret is set. */
export class WebhookMessageAdapter implements MessagePort {
  constructor(private readonly endpoint: WebhookEndpoint, private readonly format: ChatFormat, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(text: string): Promise<{ delivered: true }> {
    const body = JSON.stringify(chatBody(this.format, text));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.endpoint.secret) headers["x-brain-signature"] = signBody(this.endpoint.secret, body);
    const response = await this.fetchImpl(this.endpoint.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new BrainDomainError("INTERNAL_ERROR", `the chat webhook answered ${response.status}`);
    return { delivered: true };
  }
}

export interface Connectors { readonly tickets?: TicketPort; readonly messages?: MessagePort }

/** The connectors this server is configured with; absent ones make the matching effect tool refuse with a plain reason. */
export function connectorsFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Connectors {
  const ticket = ticketEndpoint(env);
  const url = safeEndpoint(env["BRAIN_NOTIFY_WEBHOOK_URL"]);
  const secret = env["BRAIN_NOTIFY_WEBHOOK_SECRET"];
  return {
    ...(ticket ? { tickets: new WebhookTicketAdapter(ticket, fetchImpl) } : {}),
    ...(url ? { messages: new WebhookMessageAdapter({ url: url.toString(), ...(secret ? { secret } : {}) }, chatFormat(env), fetchImpl) } : {}),
  };
}
