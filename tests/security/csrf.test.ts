import { setupCredential } from "../helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";

describe("cross-origin cookie mutations (E005)", () => {
  it("uses the configured public origin behind a TLS proxy", async () => {
    vi.stubEnv("BRAIN_BASE_URL", "https://brain.example.test");
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-csrf-proxy-")) });
    try {
      const boot = await app.brain.bootstrap({ organizationId: "org-proxy", name: "Proxy", email: "proxy@example.test", password: "fixture-password-1234" }, setupCredential(app.brain));
      const cookie = boot.cookies.map((c) => c.split(";")[0]).join("; ");
      const send = (origin: string, workspaceId: string) => app.fetch(new Request("http://127.0.0.1:3000/v1/setup/workspace", {
        method: "POST", headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ workspaceId, slug: workspaceId }),
      }));
      expect((await send("http://brain.example.test", "ws-denied")).status).toBe(403);
      expect((await send("https://brain.example.test", "ws-proxy")).status).toBe(201);
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });

  it("rejects cross-site cookie POST, allows same-origin and bearer", async () => {
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-csrf-")), allowTestActor: true });
    try {
      const bootRes = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Setup ${setupCredential(app.brain)}` },
        body: JSON.stringify({ organizationId: "org-csrf", name: "CSRF", email: "csrf@example.test", password: "fixture-password-1234" }),
      }));
      const boot = (await bootRes.json()) as { sessionToken: string };
      const cookie = bootRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      expect(boot.sessionToken).toBeTruthy();
      const body = JSON.stringify({ workspaceId: "ws-csrf", slug: "csrf" });
      const cross = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup/workspace", {
        method: "POST",
        headers: {
          "content-type": "application/json", host: "127.0.0.1:3000",
          cookie, origin: "https://evil.example",
        },
        body,
      }));
      expect(cross.status).toBe(403);
      const crossScheme = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup/workspace", {
        method: "POST", headers: { "content-type": "application/json", cookie, origin: "https://127.0.0.1:3000" }, body,
      }));
      expect(crossScheme.status).toBe(403);
      const same = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup/workspace", {
        method: "POST",
        headers: {
          "content-type": "application/json", host: "127.0.0.1:3000",
          cookie, origin: "http://127.0.0.1:3000",
        },
        body,
      }));
      expect(same.status).toBe(201);
      const bearer = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup/workspace", {
        method: "POST",
        headers: {
          "content-type": "application/json", authorization: `Bearer ${boot.sessionToken}`,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ workspaceId: "ws-csrf-2", slug: "csrf2" }),
      }));
      expect(bearer.status).toBe(201);
    } finally {
      await app.close();
    }
  });
});
