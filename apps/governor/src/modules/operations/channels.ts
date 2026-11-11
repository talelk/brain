import { createHmac } from "node:crypto";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";

/**
 * Notification channels and per-person preferences (issue #53, ADR 0011). In-app is the record and is always on. Web push keeps
 * its existing behaviour by default. A webhook exists only when the server is configured with one; its destination is a server
 * setting (never a per-person URL) and its body is a link, never content. Email is not built.
 */
export interface NotificationPreferences {
  readonly push: boolean;
  readonly webhook: boolean;
  readonly digest: boolean;
  readonly digestLastMs: number;
}

/** A person's switches; no row means today's behaviour. */
export function preferencesOf(store: Store, organizationId: string, principalId: string): NotificationPreferences {
  const row = store.control.prepare("SELECT push, webhook, digest, digest_last_ms FROM notification_preferences WHERE organization_id=? AND principal_id=?").get(organizationId, principalId) as
    | { push: number; webhook: number; digest: number; digest_last_ms: number } | undefined;
  return row ? { push: row.push === 1, webhook: row.webhook === 1, digest: row.digest === 1, digestLastMs: row.digest_last_ms } : { push: true, webhook: false, digest: false, digestLastMs: 0 };
}

export interface WebhookTarget { readonly url: string; readonly secret?: string }

/** The server's webhook, when one is configured and safe to call (https, or http only to this machine). */
export function webhookTarget(env: NodeJS.ProcessEnv = process.env): WebhookTarget | undefined {
  const raw = env["BRAIN_NOTIFY_WEBHOOK_URL"];
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  const secret = env["BRAIN_NOTIFY_WEBHOOK_SECRET"];
  return { url: url.toString(), ...(secret ? { secret } : {}) };
}

/** What the person may switch, given what this server offers. */
export function preferencesView(store: Store, organizationId: string, principalId: string): { preferences: Pick<NotificationPreferences, "push" | "webhook" | "digest">; available: { inApp: true; push: true; webhook: boolean; email: false } } {
  const current = preferencesOf(store, organizationId, principalId);
  return { preferences: { push: current.push, webhook: current.webhook, digest: current.digest }, available: { inApp: true, push: true, webhook: webhookTarget() !== undefined, email: false } };
}

export function setPreferences(store: Store, organizationId: string, principalId: string, input: { push?: unknown; webhook?: unknown; digest?: unknown }): void {
  for (const [key, value] of Object.entries(input)) if (value !== undefined && typeof value !== "boolean") throw new BrainDomainError("INVALID_ARGUMENT", `${key} must be true or false`);
  if (input.webhook === true && !webhookTarget()) throw new BrainDomainError("CONFLICT", "this server has no webhook configured, so it cannot be switched on");
  const now = store.now();
  const current = preferencesOf(store, organizationId, principalId);
  const next = { push: (input.push as boolean | undefined) ?? current.push, webhook: (input.webhook as boolean | undefined) ?? current.webhook, digest: (input.digest as boolean | undefined) ?? current.digest };
  // The digest window starts when it is switched on, so history is never dumped on the person.
  const last = next.digest && !current.digest ? now : current.digestLastMs;
  store.control.prepare(`INSERT INTO notification_preferences(organization_id, principal_id, push, webhook, digest, digest_last_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(organization_id, principal_id) DO UPDATE SET push=excluded.push, webhook=excluded.webhook, digest=excluded.digest, digest_last_ms=excluded.digest_last_ms, updated_at_ms=excluded.updated_at_ms`)
    .run(organizationId, principalId, next.push ? 1 : 0, next.webhook ? 1 : 0, next.digest ? 1 : 0, last, now);
}

/** The whole body of a webhook call: a generic sentence and a link, nothing a person typed and no secret. */
export interface WebhookBody {
  readonly type: "brain.notification";
  readonly kind: string;
  readonly text: string;
  readonly link: string;
  readonly count?: number;
}

export function webhookBody(input: { kind: string; link: string; count?: number }): WebhookBody {
  const text = input.kind === "digest" ? `Brain: ${input.count ?? 0} results are ready. Open ${input.link}`
    : input.kind === "result-ready" ? `Brain: a result is ready. Open ${input.link}`
      : input.kind === "approval" ? `Brain: an approval is waiting for you. Open ${input.link}` : `Brain: something needs you. Open ${input.link}`;
  return { type: "brain.notification", kind: input.kind, text, link: input.link, ...(input.count !== undefined ? { count: input.count } : {}) };
}

/** Posts the body once, signed when a secret is set. Best effort: a failing endpoint never breaks the in-app record. */
export async function sendWebhook(target: WebhookTarget, body: WebhookBody, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const bytes = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.secret) headers["x-brain-signature"] = `sha256=${createHmac("sha256", target.secret).update(bytes).digest("hex")}`;
  try {
    const response = await fetchImpl(target.url, { method: "POST", headers, body: bytes, redirect: "error", signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch { return false; }
}

/** An absolute link when the server knows its public address, else the path (the receiver prefixes its own base). */
export function absoluteLink(path: string, baseUrl = process.env["BRAIN_BASE_URL"]): string {
  if (!baseUrl) return path;
  try { return new URL(path, baseUrl).toString(); } catch { return path; }
}
