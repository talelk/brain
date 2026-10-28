import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tlsMaterialFromEnv } from "../../apps/governor/src/http/tls";

// T06: optional TLS serving. Partial config refuses; full config serves
// HTTPS only (plaintext HTTP to the same port does not get an HTTP answer).
const children: ChildProcess[] = [];
const dirs: string[] = [];
function killGroup(c: ChildProcess): void { try { process.kill(-c.pid!, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch { /* gone */ } } }
afterEach(() => {
  for (const c of children.splice(0)) killGroup(c);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function httpsGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (c) => { body += String(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("TLS serving (T06)", () => {
  it("partial TLS configuration is refused", () => {
    expect(() => tlsMaterialFromEnv({ BRAIN_TLS_CERT_FILE: "/tmp/x.pem" })).toThrow(/incomplete/);
    expect(tlsMaterialFromEnv({})).toBeUndefined();
  });

  it("serves HTTPS with an operator-provided certificate; plaintext gets no HTTP response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tls-"));
    dirs.push(dir);
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    execFileSync("chmod", ["600", key]);
    const port = 3321;
    const child = spawn("pnpm", ["exec", "tsx", "apps/governor/src/main.ts"], {
      cwd: process.cwd(), detached: true,
      env: {
        ...process.env, BRAIN_DATA_DIR: join(dir, "data"), PORT: String(port),
        BRAIN_BASE_URL: `https://127.0.0.1:${port}`, BRAIN_TLS_CERT_FILE: cert, BRAIN_TLS_KEY_FILE: key,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let ready: { status: number; body: string } | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !ready) {
      try { const r = await httpsGet(port, "/health/ready"); if (r.status === 200) ready = r; } catch { /* not up */ }
      if (!ready) await new Promise((r) => setTimeout(r, 400));
    }
    expect(ready?.status).toBe(200);
    expect(ready?.body).toContain('"ready":true');
    // Plaintext HTTP against the TLS port must not produce an HTTP response.
    const plain = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (plain) {
      const text = await plain.text().catch(() => "");
      expect(text).not.toContain('"ready":true');
    }
  }, 180_000);
});
