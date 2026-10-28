import { bearer, genericOAuth, organization, twoFactor } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth";
import type { Db } from "../../infrastructure/persistence/open";
import { oidcConfigFromEnv, type OidcConfig } from "./oidc";

type BrainAuthOptions = BetterAuthOptions & {
  database: Db;
  plugins: Array<ReturnType<typeof bearer> | ReturnType<typeof organization> | ReturnType<typeof twoFactor> | ReturnType<typeof genericOAuth>>;
};

export function authOptions(db: Db, opts: { secret: string; baseURL: string; oidc?: OidcConfig }): BrainAuthOptions {
  const oidc = opts.oidc ?? oidcConfigFromEnv();
  return {
    appName: "Keyrus Brain",
    database: db,
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: [new URL(opts.baseURL).origin],
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 12 * 3600, updateAge: 3600, freshAge: 300, cookieCache: { enabled: false } },
    plugins: [bearer(), ...(oidc ? [genericOAuth({
      config: [{
        providerId: "brain-oidc",
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        discoveryUrl: oidc.discoveryUrl,
        scopes: ["openid", "email", "profile"],
        pkce: true,
      }],
    })] : []), organization({
      allowUserToCreateOrganization: false, disableOrganizationDeletion: true,
      // Invitations are captured in a durable outbox; SMTP delivery is an
      // operator integration that drains invitation_outbox. The invite is
      // valid whether or not external mail is configured.
      sendInvitationEmail: async (data) => {
        db.exec("CREATE TABLE IF NOT EXISTS invitation_outbox(invitation_id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, organization_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT");
        db.prepare("INSERT OR REPLACE INTO invitation_outbox(invitation_id, email, role, organization_id, created_at_ms) VALUES (?,?,?,?,?)")
          .run(data.id, data.email, data.role, data.organization.id, Date.now());
      },
    }), twoFactor({ issuer: "Keyrus Brain" })],
  };
}
