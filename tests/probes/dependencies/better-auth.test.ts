import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBrainAuth } from "../../../apps/governor/src/modules/identity/index";

describe("G01 better-auth probe", () => {
  it("generates vendor tables, signs up, signs in, resolves session (T05)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-auth-"));
    const db = new Database(join(dir, "control.db"));
    const auth = createBrainAuth(db, { secret: "probe-secret-0123456789abcdef0123456789", baseURL: "http://127.0.0.1:3100" });
    const tables = auth.ensureTables();
    expect(tables).toContain("user");
    expect(tables).toContain("organization");
    expect(tables).toContain("twoFactor");
    expect(tables).toContain("passkey");
    expect(tables).toContain("rateLimit");
    const publicSignup = await auth.handler(new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", password: "password1234", name: "Probe" }),
    }));
    expect(publicSignup.status).toBe(403);
    const account = await auth.bootstrapAccount({ email: "a@example.test", password: "password1234", name: "Probe" });
    const uid = (await auth.readSession(new Headers({ authorization: `Bearer ${account.token}` })))?.userId;
    expect(uid).toBe(account.userId);
    db.close();
  });
});
