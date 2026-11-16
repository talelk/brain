import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { Db } from "../db";

/** Sign-in: email and password, passkeys and two-factor. Accounts are made by setup and by a workspace admin, so sign-up creates no session. */
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
    plugins: [
      passkey({ rpID: ["127.0.0.1", "localhost", "[::1]"].includes(hostname) ? "localhost" : hostname, rpName: "Brain", origin, authenticatorSelection: { residentKey: "preferred", userVerification: "required" } }),
      twoFactor({ issuer: "Brain" }),
    ],
  } satisfies BetterAuthOptions;
}
