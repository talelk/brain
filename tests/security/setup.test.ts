import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { goldenDocs, seedOrganization, seedHuman, setupCredential } from "../helpers";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

describe("setup authorization", () => {
  it("never mints impersonation sessions and refuses setup after the first organization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-setup-security-"));
    const app = await createApp({ dataDir: dir });
    const post = (path: string, body: unknown, token?: string) => app.fetch(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : path === "/v1/setup" && !app.brain.store.control.prepare("SELECT 1 FROM organizations LIMIT 1").get() ? { authorization: `Setup ${setupCredential(app.brain)}` } : {}) }, body: JSON.stringify(body),
    }));
    try {
      const boot = await post("/v1/setup", { organizationId: "org-a", name: "Org A", email: "a@example.test", password: "fixture-password-1234" });
      expect(boot.status).toBe(201);
      const { sessionToken } = await boot.json() as { sessionToken: string };
      app.brain.ensurePrincipal("org-a", "viewer-a", "human");
      const { token: viewerToken } = seedHuman(app.brain, "org-a", "viewer-a");
      const count = () => (app.brain.store.control.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n;
      const before = count();
      for (const token of [viewerToken, sessionToken, undefined]) {
        const response = await post("/v1/setup/session", { principalId: "owner-a", organizationId: "org-a" }, token);
        expect(response.status).toBe(404);
        expect((await response.json() as { code: string }).code).toBe("NOT_FOUND");
      }
      expect(count()).toBe(before);
      expect((await post("/v1/setup", { organizationId: "org-b", name: "Org B", email: "b@example.test", password: "fixture-password-1234" })).status).toBe(409);
      expect(app.brain.store.control.prepare("SELECT 1 FROM organizations WHERE id='org-b'").get()).toBeUndefined();
      for (const path of ["/v1/missing", "/runner/missing", "/api/missing"]) {
        expect((await app.fetch(new Request(`http://localhost${path}`))).status).toBe(404);
      }
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("checks current organization permissions before compiling or activating configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-config-security-"));
    const app = await createApp({ dataDir: dir });
    try {
      const boot = seedOrganization(app.brain, { organizationId: "org-config", ownerId: "owner-config" });
      app.brain.ensurePrincipal("org-config", "viewer-config", "human");
      const { token } = seedHuman(app.brain, "org-config", "viewer-config");
      const denied = await app.fetch(new Request("http://localhost/v1/setup/config", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ documents: goldenDocs(), sourceRevision: "denied", activate: true }),
      }));
      expect(denied.status).toBe(403);
      expect(app.brain.store.control.prepare("SELECT 1 FROM config_releases").get()).toBeUndefined();
      const actor = { kind: "human" as const, actorId: boot.ownerPrincipalId, organizationId: boot.organizationId,
        scopes: scopesForPrincipal(app.brain.store, boot.ownerPrincipalId, boot.organizationId), authMethod: "session" as const, authGeneration: 1 };
      const release = app.brain.stageRelease(actor, goldenDocs(), "sha256:eabc01f12ec3e7cb6db0ada0f8f37323b0cfe6d08a2a73479e7d5b62d7e63529");
      app.brain.store.control.prepare("UPDATE organization_authorizations SET revoked_at_ms=1 WHERE principal_id=?").run(actor.actorId);
      expect(() => app.brain.activateRelease(actor, release.digest)).toThrow(/administration/);
      expect(() => app.brain.stageRelease(actor, [], "sha256:e1494e35fcc079ced89cfffaded4e4b5b1531cbf51bab0f2c228c772c62369d5")).toThrow(/administration/);
      expect(app.brain.activeRelease(boot.organizationId)).toBeUndefined();
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
