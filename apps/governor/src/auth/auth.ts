import { BrainError, type User } from "@brain/contracts";
import { betterAuth } from "better-auth";
import { tx, type Db } from "../db";
import { append } from "../events";
import { authOptions } from "./options";

/** Sign-in, as the rest of the Governor uses it. better-auth owns the sign-in tables and the `/api/auth/*` routes. */
export interface Auth {
  /** The `/api/auth/*` routes. */
  handler(request: Request): Promise<Response>;
  /** The person a request's session cookie belongs to, or null. */
  user(headers: Headers): Promise<User | null>;
  /** The account with this email, if there is one. */
  find(email: string): { id: string; name: string; email: string } | undefined;
  /** Makes an account without signing anyone in. Returns the user id. */
  createAccount(input: { email: string; name: string; password: string }): Promise<string>;
  /** The keyed hash better-auth keeps of a password. */
  hashPassword(password: string): Promise<string>;
  /** True when `password` is the one the person signs in with. */
  verifyPassword(userId: string, password: string): Promise<boolean>;
  /** Signs in and returns the cookies that carry the session. */
  signIn(email: string, password: string): Promise<{ userId: string; cookies: string[] }>;
}

export function createAuth(db: Db, opts: { secret: string; baseUrl: string }): Auth {
  const auth = betterAuth(authOptions(db, opts));
  return {
    async handler(request) {
      // A refused password is recorded for an account that exists (an unknown address leaves nothing: the log is no way to learn who has one).
      const failed = new URL(request.url).pathname === "/api/auth/sign-in/email" ? ((await request.clone().json().catch(() => null)) as { email?: unknown } | null)?.email : undefined;
      const response = await auth.handler(request);
      if (typeof failed === "string" && response.status === 401) {
        const known = db.prepare('SELECT id FROM "user" WHERE email=?').get(failed.trim().toLowerCase()) as { id: string } | undefined;
        if (known) tx(db, () => append(db, { type: "user.sign_in_failed", subject: `user:${known.id}`, payload: { userAgent: (request.headers.get("user-agent") ?? "").slice(0, 200) || null }, actor: { kind: "system", id: "sign-in" } }));
      }
      return response;
    },
    async user(headers) {
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } }).catch(() => null);
      if (!session) return null;
      // A deactivated person's sessions are deleted when they are deactivated; this keeps one that somehow survives from working.
      if (db.prepare("SELECT 1 FROM deactivated_users WHERE user_id=?").get(session.user.id)) return null;
      const instanceAdmin = db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(session.user.id) !== undefined;
      return { id: session.user.id, name: session.user.name, email: session.user.email, instanceAdmin, sessionId: session.session.id };
    },
    find: (email) => db.prepare('SELECT id, name, email FROM "user" WHERE email=?').get(email) as { id: string; name: string; email: string } | undefined,
    async createAccount(input) {
      const made = await auth.api.signUpEmail({ body: input });
      return made.user.id;
    },
    async hashPassword(password) {
      return (await auth.$context).password.hash(password);
    },
    async verifyPassword(userId, password) {
      const row = db.prepare(`SELECT password FROM account WHERE "userId"=? AND "providerId"='credential'`).get(userId) as { password: string | null } | undefined;
      return row?.password ? (await auth.$context).password.verify({ hash: row.password, password }) : false;
    },
    async signIn(email, password) {
      const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      const body = response.ok ? ((await response.json()) as { user?: { id?: string } }) : undefined;
      if (!body?.user?.id) throw new BrainError("UNAUTHENTICATED", "The email or the password is wrong");
      return { userId: body.user.id, cookies: response.headers.getSetCookie() };
    },
  };
}
