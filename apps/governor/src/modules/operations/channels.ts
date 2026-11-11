import { createHmac } from "node:crypto";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { sendMail, smtpTarget, validAddress, type SmtpTarget } from "./smtp";

/**
 * Notification channels and per-person preferences (issue #53, ADR 0011). In-app is the record and is always on. Web push keeps
 * its existing behaviour by default. A webhook exists only when the server is configured with one; its destination is a server
 * setting (never a per-person URL) and its body is a link, never content. Email is not built.
 */
export interface NotificationPreferences {
  readonly push: boolean;
  readonly webhook: boolean;
  readonly digest: boolean;
  readonly email: boolean;
  readonly digestLastMs: number;
}

/** A person's switches; no row means today's behaviour. */
export function preferencesOf(store: Store, organizationId: string, principalId: string): NotificationPreferences {
  const row = store.control.prepare("SELECT push, webhook, digest, email, digest_last_ms FROM notification_preferences WHERE organization_id=? AND principal_id=?").get(organizationId, principalId) as
    | { push: number; webhook: number; digest: number; email: number; digest_last_ms: number } | undefined;
  return row ? { push: row.push === 1, webhook: row.webhook === 1, digest: row.digest === 1, email: row.email === 1, digestLastMs: row.digest_last_ms } : { push: true, webhook: false, digest: false, email: false, digestLastMs: 0 };
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

export interface EmailDelivery { readonly kind: string; readonly status: "sent" | "failed"; readonly reason: string; readonly at: string }

/** What the person may switch, given what this server offers, and how their latest emails went. */
export function preferencesView(store: Store, organizationId: string, principalId: string): { preferences: Pick<NotificationPreferences, "push" | "webhook" | "digest" | "email">; available: { inApp: true; push: true; webhook: boolean; email: boolean }; emailDeliveries: EmailDelivery[] } {
  const current = preferencesOf(store, organizationId, principalId);
  const rows = store.control.prepare("SELECT kind, status, reason, at_ms FROM email_deliveries WHERE organization_id=? AND principal_id=? ORDER BY id DESC LIMIT 10").all(organizationId, principalId) as Array<{ kind: string; status: "sent" | "failed"; reason: string; at_ms: number }>;
  return {
    preferences: { push: current.push, webhook: current.webhook, digest: current.digest, email: current.email },
    available: { inApp: true, push: true, webhook: webhookTarget() !== undefined, email: smtpTarget() !== undefined },
    emailDeliveries: rows.map((row) => ({ kind: row.kind, status: row.status, reason: row.reason, at: iso(row.at_ms) })),
  };
}

export function setPreferences(store: Store, organizationId: string, principalId: string, input: { push?: unknown; webhook?: unknown; digest?: unknown; email?: unknown }): void {
  for (const [key, value] of Object.entries(input)) if (value !== undefined && typeof value !== "boolean") throw new BrainDomainError("INVALID_ARGUMENT", `${key} must be true or false`);
  if (input.webhook === true && !webhookTarget()) throw new BrainDomainError("CONFLICT", "this server has no webhook configured, so it cannot be switched on");
  if (input.email === true && !smtpTarget()) throw new BrainDomainError("CONFLICT", "Email is not configured on this server, so it cannot be switched on");
  const now = store.now();
  const current = preferencesOf(store, organizationId, principalId);
  const next = { push: (input.push as boolean | undefined) ?? current.push, webhook: (input.webhook as boolean | undefined) ?? current.webhook, digest: (input.digest as boolean | undefined) ?? current.digest, email: (input.email as boolean | undefined) ?? current.email };
  // The digest window starts when it is switched on, so history is never dumped on the person.
  const last = next.digest && !current.digest ? now : current.digestLastMs;
  store.control.prepare(`INSERT INTO notification_preferences(organization_id, principal_id, push, webhook, digest, email, digest_last_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(organization_id, principal_id) DO UPDATE SET push=excluded.push, webhook=excluded.webhook, digest=excluded.digest, email=excluded.email, digest_last_ms=excluded.digest_last_ms, updated_at_ms=excluded.updated_at_ms`)
    .run(organizationId, principalId, next.push ? 1 : 0, next.webhook ? 1 : 0, next.digest ? 1 : 0, next.email ? 1 : 0, last, now);
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

/** A link safe for a mail body: this server's path with only the ids the page needs. No credential-like parameter can pass. */
export function safeMailLink(path: string, baseUrl = process.env["BRAIN_BASE_URL"]): string {
  let url: URL;
  try { url = new URL(path, baseUrl ?? "http://brain.invalid"); } catch { return "/"; }
  const keep = new URLSearchParams();
  for (const key of ["w", "asset", "result"]) { const value = url.searchParams.get(key); if (value && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) keep.set(key, value); }
  const query = keep.toString();
  const clean = `${url.pathname}${query ? `?${query}` : ""}`;
  return baseUrl ? absoluteLink(clean, baseUrl) : clean;
}

/** The whole mail: a generic sentence and a link. Nothing a person typed, no title, no token, no secret (same rule as the webhook). */
export function emailContent(input: { kind: string; link: string; count?: number }): { subject: string; text: string } {
  const subject = input.kind === "digest" ? "Brain: results are ready" : input.kind === "result-ready" ? "Brain: a result is ready" : input.kind === "approval" ? "Brain: an approval is waiting for you" : "Brain: something needs you";
  const lead = input.kind === "digest" ? `${input.count ?? 0} ${input.count === 1 ? "result is" : "results are"} ready.` : input.kind === "result-ready" ? "A result is ready." : input.kind === "approval" ? "An approval is waiting for you." : "Something needs you.";
  return { subject, text: `${lead}\n\nOpen it in Brain: ${input.link}\n\nYou will be asked to sign in first${input.kind === "approval" ? " and to confirm the approval again" : ""}. You receive this because you switched email on under Settings > Security > Where Brain reaches you.\n` };
}

/** At most this many emails per person per hour; blocking items included, so a runaway loop cannot flood an inbox. */
export function emailLimitPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env["BRAIN_NOTIFY_EMAIL_PER_HOUR"]);
  return Number.isInteger(value) && value > 0 ? value : 6;
}
const HOUR_MS = 60 * 60_000;
/** The whole server sends at most this many an hour, whoever the people are. */
const SERVER_EMAILS_PER_HOUR = 300;

function record(store: Store, organizationId: string, principalId: string, kind: string, status: "sent" | "failed", reason: string): void {
  store.control.prepare("INSERT INTO email_deliveries(organization_id, principal_id, kind, status, reason, at_ms) VALUES (?,?,?,?,?,?)").run(organizationId, principalId, kind, status, reason.slice(0, 200), store.now());
}

/**
 * Emails one person (when the server has SMTP), within the rate limit, and records the outcome. Returns whether the mail server accepted it.
 * Never throws: email is best effort and the in-app inbox stays the record.
 */
export async function sendEmail(store: Store, organizationId: string, principalId: string, message: { kind: string; url: string; count?: number }, send: (target: SmtpTarget, mail: { to: string; subject: string; text: string }) => Promise<void> = (target, mail) => sendMail(target, mail)): Promise<boolean> {
  const target = smtpTarget();
  if (!target) return false;
  const since = store.now() - HOUR_MS;
  const counted = "at_ms>? AND reason NOT LIKE 'rate limited%'";
  const own = (store.control.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE organization_id=? AND principal_id=? AND ${counted}`).get(organizationId, principalId, since) as { n: number }).n;
  const all = (store.control.prepare(`SELECT COUNT(*) AS n FROM email_deliveries WHERE ${counted}`).get(since) as { n: number }).n;
  if (own >= emailLimitPerHour()) { record(store, organizationId, principalId, message.kind, "failed", `rate limited: at most ${emailLimitPerHour()} emails an hour`); return false; }
  if (all >= SERVER_EMAILS_PER_HOUR) { record(store, organizationId, principalId, message.kind, "failed", "rate limited: this server's hourly email limit is reached"); return false; }
  const row = store.control.prepare('SELECT u.email AS email FROM principals p JOIN "user" u ON u.id=p.auth_subject_id WHERE p.id=? AND p.organization_id=? AND p.kind=\'human\' AND p.disabled_at_ms IS NULL').get(principalId, organizationId) as { email: string } | undefined;
  if (!row || !validAddress(row.email)) { record(store, organizationId, principalId, message.kind, "failed", "no valid email address for this person"); return false; }
  const content = emailContent({ kind: message.kind, link: safeMailLink(message.url), ...(message.count !== undefined ? { count: message.count } : {}) });
  try {
    await send(target, { to: row.email, ...content });
    record(store, organizationId, principalId, message.kind, "sent", "");
    return true;
  } catch (error) {
    // The reason is the server's short answer or a local fault, cut so a verbose relay cannot fill the table; it never carries credentials.
    record(store, organizationId, principalId, message.kind, "failed", (error instanceof Error ? error.message : "send failed").replace(/\s+/gu, " "));
    return false;
  }
}
