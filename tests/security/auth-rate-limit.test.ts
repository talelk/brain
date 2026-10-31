import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); delete process.env["BRAIN_AUTH_RATE_LIMIT"]; });

describe("Better Auth persistent rate limiting", () => {
  it("bounds repeated sign-in attempts and stores counters in SQLite", async () => {
    process.env["BRAIN_AUTH_RATE_LIMIT"] = "true";
    const dir = mkdtempSync(join(tmpdir(), "brain-auth-rate-limit-"));
    const app = await createApp({ dataDir: dir });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await app.fetch(new Request("http://127.0.0.1:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@example.test", password: "incorrect-password" }) }));
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
    expect((app.brain.store.control.prepare("SELECT COUNT(*) AS count FROM rateLimit").get() as { count: number }).count).toBeGreaterThan(0);
  });
});
