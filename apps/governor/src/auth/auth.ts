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

/** A refused sign-in is one audit row per account in a window; the rest of the window is counted and written as one more row when it ends. */
const FAILURE_WINDOW_MS = 60_000;

export function createAuth(db: Db, opts: { secret: string; baseUrl: string }): Auth {
  const auth = betterAuth(authOptions(db, opts));
  const failures = new Map<string, number>();
  const note = (userId: string, userAgent: string | null, deactivated: boolean): void => {
    const seen = failures.get(userId);
    if (seen !== undefined) { failures.set(userId, seen + 1); return; }
    failures.set(userId, 0);
    tx(db, () => append(db, { type: "user.sign_in_failed", subject: `user:${userId}`, payload: { userAgent, count: 1, deactivated }, actor: { kind: "system", id: "sign-in" } }));
    setTimeout(() => {
      const more = failures.get(userId) ?? 0;
      failures.delete(userId);
      if (more > 0) try { tx(db, () => append(db, { type: "user.sign_in_failed", subject: `user:${userId}`, payload: { userAgent, count: more, deactivated }, actor: { kind: "system", id: "sign-in" } })); } catch { /* the database is closing */ }
    }, FAILURE_WINDOW_MS).unref();
  };
  return {
    async handler(request) {
      // A refused sign-in is recorded for an account that exists (an unknown address leaves nothing: the log is no way to learn who has one).
      // A deactivated account gets the answer of a wrong password, so the answer says nothing about the account.
      const email = new URL(request.url).pathname === "/api/auth/sign-in/email" ? ((await request.clone().json().catch(() => null)) as { email?: unknown } | null)?.email : undefined;
      const response = await auth.handler(request);
      if (typeof email !== "string" || (response.status !== 401 && response.status !== 403)) return response;
      const known = db.prepare('SELECT id, EXISTS(SELECT 1 FROM deactivated_users d WHERE d.user_id = "user".id) AS off FROM "user" WHERE email=?').get(email.trim().toLowerCase()) as { id: string; off: number } | undefined;
      if (response.status === 403 && !known?.off) return response;
      if (known) note(known.id, (request.headers.get("user-agent") ?? "").slice(0, 200) || null, known.off === 1);
      return response.status === 401 ? response : Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, { status: 401 });
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
