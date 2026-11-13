import type { Db } from "../../infrastructure/persistence/open";
import { OIDC_PROVIDER_ID } from "./oidc";

/**
 * Authenticator enrolment for a person who signs in only through the company directory (ADR 0026, amended; backlog 92).
 *
 * The pinned sign-in vendor asks for the account's password before it sets up, reads, regenerates or removes an authenticator. A
 * directory-only person has no password, so the vendor is configured to allow that case (`allowPasswordless`) and this module decides
 * when: such a person may enroll only through a directory sign-in that is still fresh. Once the authenticator exists nothing can read,
 * regenerate or remove it without a password, so a stolen directory session can never add its own factor later, read the secret, or swap
 * the factor that guards approvals. A person who has a password is untouched: the vendor still demands it on every one of these calls.
 */

/** The vendor routes (under /api/auth) that change or reveal a person's authenticator. */
export const AUTHENTICATOR_PATHS: ReadonlySet<string> = new Set(["/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"]);

/** How recent the directory sign-in must be: the session's own freshness window. */
export const ENROLL_FRESH_MS = 300_000;

/** The vendor path of a request to the auth handler, or undefined when it is not under it. */
export function authPath(url: string): string | undefined {
  const pathname = new URL(url).pathname;
  return pathname.startsWith("/api/auth/") ? pathname.slice("/api/auth".length) : undefined;
}

/** Why a signed-in person may not touch their authenticator through this route, or undefined when the vendor may decide (a person with a password). */
export function directoryAuthenticatorRefusal(db: Db, who: { userId: string; sessionId: string }, path: string, nowMs: number): string | undefined {
  const hasPassword = !!db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL AND password<>''").get(who.userId);
  if (hasPassword) return undefined;
  const fromDirectory = !!db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId=?").get(who.userId, OIDC_PROVIDER_ID);
  if (path === "/two-factor/enable" && fromDirectory) {
    const row = db.prepare('SELECT createdAt FROM "session" WHERE id=?').get(who.sessionId) as { createdAt: number | string } | undefined;
    const created = row ? (typeof row.createdAt === "number" ? row.createdAt : new Date(row.createdAt).getTime()) : Number.NaN;
    if (Number.isFinite(created) && nowMs - created <= ENROLL_FRESH_MS) return undefined;
    return "Sign in through the company directory again, then set up the authenticator right away";
  }
  return "This account has no password: its authenticator can be set up once, right after a company directory sign-in, and cannot be changed here";
}
