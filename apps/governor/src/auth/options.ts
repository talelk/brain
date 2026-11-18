import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { tx, type Db } from "../db";
import { append } from "../events";

/**
 * Sign-in: email and password, passkeys and two-factor. Accounts are made by setup, by an invitation and by a workspace admin, so sign-up
 * creates no session. Every session, whatever way it is made, is refused to a deactivated person and recorded in the audit log.
 */
export function authOptions(db: Db, opts: { secret: string; baseUrl: string }) {
  const origin = new URL(opts.baseUrl).origin;
  const hostname = new URL(origin).hostname;
  const trustedProxies = process.env["BRAIN_AUTH_TRUSTED_PROXIES"]?.split(",").map((value) => value.trim()).filter(Boolean);
  return {
    appName: "Brain",
    database: db,
    secret: opts.secret,
    baseURL: opts.baseUrl,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 12 * 3600, updateAge: 3600, freshAge: 300, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: process.env["NODE_ENV"] === "production",
      storage: "database",
      window: 10,
      max: 100,
      customRules: { "/sign-in/email": { window: 10, max: 5 }, "/sign-in/passkey": { window: 10, max: 5 }, "/two-factor/*": { window: 10, max: 3 } },
    },
    ...(trustedProxies?.length ? { advanced: { ipAddress: { trustedProxies, ipAddressHeaders: ["x-forwarded-for"] } } } : {}),
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            if (db.prepare("SELECT 1 FROM deactivated_users WHERE user_id=?").get(session.userId)) throw new APIError("FORBIDDEN", { message: "This account is deactivated" });
          },
          after: async (session: { userId: string; ipAddress?: string | null | undefined; userAgent?: string | null | undefined }) => {
            tx(db, () => append(db, { type: "user.signed_in", subject: `user:${session.userId}`, payload: { ipAddress: session.ipAddress ?? null, userAgent: (session.userAgent ?? "").slice(0, 200) || null }, actor: { kind: "person", id: session.userId } }));
          },
        },
      },
    },
    plugins: [
      passkey({ rpID: ["127.0.0.1", "localhost", "[::1]"].includes(hostname) ? "localhost" : hostname, rpName: "Brain", origin, authenticatorSelection: { residentKey: "preferred", userVerification: "required" } }),
      twoFactor({ issuer: "Brain" }),
    ],
  } satisfies BetterAuthOptions;
}
