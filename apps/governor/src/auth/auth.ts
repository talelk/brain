import { BrainError, type User } from "@brain/contracts";
import { betterAuth } from "better-auth";
import type { Db } from "../db";
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
  /** Signs in and returns the cookies that carry the session. */
  signIn(email: string, password: string): Promise<{ userId: string; cookies: string[] }>;
}

export function createAuth(db: Db, opts: { secret: string; baseUrl: string }): Auth {
  const auth = betterAuth(authOptions(db, opts));
  return {
    handler: (request) => auth.handler(request),
    async user(headers) {
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } }).catch(() => null);
      if (!session) return null;
      const instanceAdmin = db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(session.user.id) !== undefined;
      return { id: session.user.id, name: session.user.name, email: session.user.email, instanceAdmin };
    },
    find: (email) => db.prepare('SELECT id, name, email FROM "user" WHERE email=?').get(email) as { id: string; name: string; email: string } | undefined,
    async createAccount(input) {
      const made = await auth.api.signUpEmail({ body: input });
      return made.user.id;
    },
    async signIn(email, password) {
      const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      const body = response.ok ? ((await response.json()) as { user?: { id?: string } }) : undefined;
      if (!body?.user?.id) throw new BrainError("UNAUTHENTICATED", "The email or the password is wrong");
      return { userId: body.user.id, cookies: response.headers.getSetCookie() };
    },
  };
}
