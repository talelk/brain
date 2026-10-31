import { createAuthMiddleware, APIError } from "better-auth/api";
import { admin, bearer, genericOAuth, organization, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import type { Db } from "../../infrastructure/persistence/open";
import { oidcConfigFromEnv, type OidcConfig } from "./oidc";

type BrainAuthOptions = BetterAuthOptions & { database: Db };

export function authOptions(db: Db, opts: { secret: string; baseURL: string; oidc?: OidcConfig }): BrainAuthOptions {
  const oidc = opts.oidc ?? oidcConfigFromEnv();
  const origin = new URL(opts.baseURL).origin;
  const trustedProxies = process.env["BRAIN_AUTH_TRUSTED_PROXIES"]?.split(",").map((value) => value.trim()).filter(Boolean);
  return {
    appName: "Keyrus Brain",
    database: db,
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        const invitation = db.prepare("SELECT id,organizationId FROM invitation WHERE lower(email)=? AND status='pending' AND expiresAt>? ORDER BY createdAt DESC LIMIT 1").get(user.email.toLowerCase(), Date.now()) as { id: string; organizationId: string } | undefined;
        const verificationUrl = new URL(url);
        if (invitation) verificationUrl.searchParams.set("callbackURL", `/accept-invitation/${encodeURIComponent(invitation.id)}`);
        db.prepare("INSERT OR REPLACE INTO auth_email_outbox(id,kind,email,url,organization_id,state,attempt_count,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'pending',0,?,?)")
          .run(`verify:${token}`, "verify-email", user.email, verificationUrl.href, invitation?.organizationId ?? null, Date.now(), Date.now());
      },
    },
    session: { expiresIn: 12 * 3600, updateAge: 3600, freshAge: 300, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: process.env["NODE_ENV"] === "production" || process.env["BRAIN_AUTH_RATE_LIMIT"] === "true",
      storage: "database",
      window: 10,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 10, max: 5 },
        "/sign-in/passkey": { window: 10, max: 5 },
        "/two-factor/*": { window: 10, max: 3 },
        "/organization/accept-invitation": { window: 10, max: 5 },
      },
    },
    ...(trustedProxies?.length ? { advanced: { ipAddress: { trustedProxies, ipAddressHeaders: ["x-forwarded-for"] } } } : {}),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || !ctx.request) return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.toLowerCase() : "";
        const invitation = db.prepare("SELECT 1 AS allowed FROM invitation WHERE lower(email)=? AND status='pending' AND expiresAt>? LIMIT 1").get(email, Date.now());
        if (!invitation) throw new APIError("FORBIDDEN", { message: "An active organization invitation is required" });
      }),
      after: createAuthMiddleware(async (ctx) => {
        const eventTypes: Record<string, string> = {
          "/sign-in/email": "auth.sign-in.password",
          "/sign-in/passkey": "auth.sign-in.passkey",
          "/passkey/verify-registration": "auth.passkey.registered",
          "/organization/accept-invitation": "organization.invitation.accepted",
        };
        const eventType = eventTypes[ctx.path];
        if (!eventType) return;
        const returned = ctx.context.returned as { user?: { id?: string }; userId?: string; session?: { userId?: string }; member?: { userId?: string; organizationId?: string } } | undefined;
        const userId = returned?.user?.id ?? returned?.userId ?? returned?.session?.userId ?? returned?.member?.userId;
        if (!userId) return;
        db.prepare("INSERT INTO auth_security_events(event_type,user_id,auth_organization_id,occurred_at_ms) VALUES (?,?,?,?)")
          .run(eventType, userId, returned?.member?.organizationId ?? null, Date.now());
      }),
    },
    plugins: [
      bearer(),
      admin({ defaultRole: "user" }),
      passkey({ rpID: ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname) ? "localhost" : new URL(origin).hostname, rpName: "Keyrus Brain", origin, authenticatorSelection: { residentKey: "preferred", userVerification: "required" } }),
      ...(oidc ? [genericOAuth({
        config: [{
          providerId: "brain-oidc",
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
          discoveryUrl: oidc.discoveryUrl,
          scopes: ["openid", "email", "profile"],
          pkce: true,
          disableSignUp: true,
          requireEmailVerification: true,
        }],
      })] : []),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async (data) => {
          const url = `${origin}/accept-invitation/${encodeURIComponent(data.id)}`;
          db.prepare("INSERT OR REPLACE INTO auth_email_outbox(id,kind,email,url,organization_id,state,attempt_count,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'pending',0,?,?)")
            .run(`invitation:${data.id}`, "organization-invitation", data.email, url, data.organization.id, Date.now(), Date.now());
        },
      }),
      twoFactor({ issuer: "Keyrus Brain" }),
    ],
  } satisfies BetterAuthOptions;
}
