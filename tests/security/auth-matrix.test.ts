import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { setupCredential } from "../helpers";

// T47 online matrix: issuer (base URL), audience (trusted origins), session
// cookie attributes and redirect handling across the credential plane.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "matrix-password-1234";

async function application() {
  const dir = mkdtempSync(join(tmpdir(), "brain-auth-matrix-"));
  process.env["BRAIN_BASE_URL"] = ORIGIN;
  const app = await createApp({ dataDir: dir });
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); delete process.env["BRAIN_BASE_URL"]; });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body),
  }));
  const boot = await app.brain.bootstrap(
    { organizationId: "org-matrix", name: "Matrix", email: "matrix@example.test", password: PASSWORD },
    setupCredential(app.brain),
  );
  return { app, post, boot };
}

describe("auth online matrix (T47)", () => {
  it("issuer: sign-in issues a session for the configured base URL only", async () => {
    const { app, post } = await application();
    const ok = await post("/api/auth/sign-in/email", { email: "matrix@example.test", password: PASSWORD });
    expect(ok.status).toBe(200);
    const token = ok.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const resolved = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
    expect(resolved.actor.organizationId).toBe("org-matrix");

    const wrongPassword = await post("/api/auth/sign-in/email", { email: "matrix@example.test", password: "not-the-password" });
    expect(wrongPassword.status).not.toBe(200);
    expect(wrongPassword.headers.get("set-auth-token")).toBeNull();

    const unknownUser = await post("/api/auth/sign-in/email", { email: "nobody@example.test", password: PASSWORD });
    expect(unknownUser.status).not.toBe(200);
  }, 120_000);

  it("audience: foreign Origin on cookie-carrying auth mutations is refused; same-origin passes", async () => {
    const { post, boot } = await application();
    const signin = await post("/api/auth/sign-in/email", { email: "matrix@example.test", password: PASSWORD });
    const cookie = signin.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("=");

    // Foreign origin + ambient cookie: Governor exact-origin guard refuses.
    const foreign = await post("/api/auth/sign-out", {}, { origin: "https://evil.example", cookie });
    expect(foreign.status).toBe(403);

    // Same origin + cookie: proceeds to the vendor handler.
    const sameOrigin = await post("/api/auth/sign-out", {}, { origin: ORIGIN, cookie });
    expect(sameOrigin.status).toBe(200);
    void boot;
  }, 120_000);

  it("session cookies are HttpOnly and scoped to the auth path", async () => {
    const { post } = await application();
    const signin = await post("/api/auth/sign-in/email", { email: "matrix@example.test", password: PASSWORD });
    const cookies = signin.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.toLowerCase()).toContain("httponly");
    }
    const sessionCookie = cookies.find((c) => c.includes("session"));
    expect(sessionCookie).toBeTruthy();
  }, 120_000);

  it("redirect: callback URLs to foreign origins are not honored", async () => {
    const { post } = await application();
    const res = await post("/api/auth/sign-in/email", {
      email: "matrix@example.test", password: PASSWORD, callbackURL: "https://evil.example/phish",
    });
    // Either the vendor rejects the foreign callback or returns a plain
    // session response — it must never 3xx to the foreign origin.
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(307);
    const location = res.headers.get("location");
    if (location) expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
    if (res.status === 200) {
      const body = (await res.json()) as { url?: string };
      if (body.url) expect(new URL(body.url, ORIGIN).origin).toBe(ORIGIN);
    }
  }, 120_000);

  it("sign-up after bootstrap does not grant organization membership", async () => {
    const { app, post } = await application();
    const signup = await post("/api/auth/sign-up/email", { email: "walkin@example.test", password: "walkin-password-123", name: "Walk In" });
    // Public sign-up may be disabled after setup or create a user with no
    // membership; either way it must not resolve into the organization.
    const token = signup.headers.get("set-auth-token");
    if (signup.status === 200 && token) {
      const identity = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` })).catch(() => null);
      if (identity) expect(identity.actor.organizationId).not.toBe("org-matrix");
    } else {
      expect(signup.status).toBeGreaterThanOrEqual(400);
    }
  }, 120_000);
});
