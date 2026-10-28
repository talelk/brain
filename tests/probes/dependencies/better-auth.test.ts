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
    const signup = await auth.handler(new Request("http://127.0.0.1:3100/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", password: "password1234", name: "Probe" }),
    }));
    expect(signup.status).toBeLessThan(400);
    const signin = await auth.handler(new Request("http://127.0.0.1:3100/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", password: "password1234" }),
    }));
    expect(signin.status).toBeLessThan(400);
    const cookie = signin.headers.get("set-cookie") ?? "";
    const uid = (await auth.readSession(new Headers({ cookie })))?.userId;
    expect(uid).toBeTruthy();
    db.close();
  });
});
