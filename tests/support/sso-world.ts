import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { startFakeOidc, type FakeOidc, type FakeUser } from "./fake-oidc";

export const SSO_ORIGIN = "http://127.0.0.1:3000";
export const SSO_CLIENT_ID = "brain-test-client";
/** Only ever written to a 0600 file in a temp directory: tests assert it appears nowhere Brain stores or returns. */
export const SSO_CLIENT_SECRET = "oidc-client-secret-for-tests-0001";

export interface SsoWorld {
  readonly w: TestWorld;
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly idp: FakeOidc;
  readonly secretFile: string;
  /** Owner of the organization, as a test actor header (the owner holds the administrator roles). */
  readonly ownerHeaders: Record<string, string>;
  command(headers: Record<string, string>, commandType: string, payload: Record<string, unknown>, key?: string): Promise<Response>;
  query(headers: Record<string, string>, body: Record<string, unknown>): Promise<Response>;
  /** Saves the single sign-on setting as the owner. */
  configure(payload?: Record<string, unknown>): Promise<Response>;
  /** Walks the whole browser flow for a directory user and returns the session cookie (or the error the callback redirected to). */
  signIn(user: FakeUser, between?: () => Promise<void>): Promise<{ ok: boolean; location: string; cookie: string }>;
  /** Headers of a signed-in person: the real session cookie, same-origin. */
  as(cookie: string): Record<string, string>;
  close(): Promise<void>;
}

export async function ssoWorld(options: { requireTwoFactor?: boolean } = {}): Promise<SsoWorld> {
  const dir = mkdtempSync(join(tmpdir(), "brain-sso-"));
  const app = await createApp({ dataDir: join(dir, "data"), allowTestActor: true, ...(options.requireTwoFactor ? { runtime: { requireTwoFactor: true, memoryUiUrl: null } } : {}) });
  const w = setupWorld(app.brain);
  const idp = await startFakeOidc({ clientId: SSO_CLIENT_ID, clientSecret: SSO_CLIENT_SECRET });
  // A secret file must live in the Governor's own secrets folder.
  mkdirSync(join(dir, "data", "secrets"), { recursive: true, mode: 0o700 });
  const secretFile = join(dir, "data", "secrets", "oidc-secret");
  writeFileSync(secretFile, `${SSO_CLIENT_SECRET}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  const ownerHeaders = { "x-brain-test-actor": `owner-1:${w.org}` };
  const send = async (path: string, headers: Record<string, string>, body: unknown): Promise<Response> => app.fetch(new Request(`${SSO_ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: SSO_ORIGIN, ...headers }, body: JSON.stringify(body) }));
  let counter = 0;
  const world: SsoWorld = {
    w, app, idp, secretFile, ownerHeaders,
    command: (headers, commandType, payload, key = `sso-${++counter}`) => send("/v1/commands", headers, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, payload }),
    query: (headers, body) => send("/v1/query", headers, body),
    configure: (payload = {}) => world.command(ownerHeaders, "identity.oidc.set", { enabled: true, issuer: idp.issuer, clientId: SSO_CLIENT_ID, secretRef: `file:${secretFile}`, autoProvision: true, defaultRole: "operator", workspaceIds: [w.workspaceId], ...payload }),
    as: (cookie) => ({ cookie, origin: SSO_ORIGIN }),
    async signIn(user, between) {
      idp.loginAs(user);
      const jar = new Map<string, string>();
      const keep = (response: Response) => { for (const line of response.headers.getSetCookie()) { const [pair = ""] = line.split(";"); const at = pair.indexOf("="); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)); } };
      const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const start = await app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/sso/start?next=/today`));
      if (start.status !== 302) return { ok: false, location: `start:${start.status}`, cookie: "" };
      keep(start);
      await between?.();
      const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
      const callbackUrl = authorize.headers.get("location");
      if (authorize.status !== 302 || !callbackUrl) return { ok: false, location: `authorize:${authorize.status}`, cookie: "" };
      const callback = await app.fetch(new Request(callbackUrl, { headers: { cookie: cookie() } }));
      keep(callback);
      const location = callback.headers.get("location") ?? "";
      return { ok: callback.status === 302 && !location.includes("error=") && [...jar.keys()].some((name) => name.includes("session_token")), location, cookie: cookie() };
    },
    async close() { await app.close(); await idp.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  return world;
}
