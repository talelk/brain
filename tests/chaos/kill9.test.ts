import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// T18: kill -9 mid-operation must lose nothing durable; a corrupted WAL/DB
// must fail loudly at startup, never silently reinitialize over the data.
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) killGroup(c, "SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startGovernor(dataDir: string, port: number): ChildProcess {
  const child = spawn("pnpm", ["exec", "tsx", "apps/governor/src/main.ts"], {
    cwd: process.cwd(), detached: true,
    env: { ...process.env, BRAIN_DATA_DIR: dataDir, PORT: String(port), BRAIN_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

async function waitReady(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function bootstrap(port: number, dataDir: string): Promise<void> {
  const credential = readFileSync(join(dataDir, "setup.token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}/v1/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Setup ${credential}`, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ organizationId: "org-kill9", name: "Kill9", email: "kill9@example.test", password: "kill9-password-1234" }),
  });
  expect(res.status, await res.clone().text().catch(() => "")).toBeLessThan(300);
}

describe("kill-9 and WAL corruption drills (T18)", () => {
  it("kill -9 after committed bootstrap: restart serves and data survives integrity check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-kill9-"));
    dirs.push(dir);
    const port = 3317;
    const first = startGovernor(dir, port);
    expect(await waitReady(port)).toBe(true);
    await bootstrap(port, dir);
    killGroup(first, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    const second = startGovernor(dir, port);
    expect(await waitReady(port)).toBe(true);
    const signin = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ email: "kill9@example.test", password: "kill9-password-1234" }),
    });
    expect(signin.status).toBe(200);
    killGroup(second, "SIGTERM");
    await new Promise((r) => setTimeout(r, 800));

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(dir, "control.db"), { readonly: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    expect(integrity).toBe("ok");
    db.close();
  }, 240_000);

  it("corrupted control database: startup fails loudly and leaves the bytes untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-wal-"));
    dirs.push(dir);
    const port = 3318;
    const first = startGovernor(dir, port);
    expect(await waitReady(port)).toBe(true);
    await bootstrap(port, dir);
    killGroup(first, "SIGTERM");
    await new Promise((r) => setTimeout(r, 800));

    const copy = mkdtempSync(join(tmpdir(), "brain-wal-corrupt-"));
    dirs.push(copy);
    cpSync(dir, copy, { recursive: true });
    const walPath = join(copy, "control.db-wal");
    const target = existsSync(walPath) && statSync(walPath).size > 64 ? walPath : join(copy, "control.db");
    const bytes = readFileSync(target);
    // Corrupt header + a mid-file span: SQLite must not accept this silently.
    for (let i = 0; i < Math.min(64, bytes.length); i++) bytes[i] = (bytes[i]! ^ 0xff) & 0xff;
    writeFileSync(target, bytes);
    const corruptedHash = readFileSync(target).subarray(0, 64).toString("hex");

    const doomed = startGovernor(copy, port);
    const ready = await waitReady(port, 25_000);
    const exited = await Promise.race([
      new Promise<number | null>((resolve) => doomed.once("exit", (code) => resolve(code))),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    expect(ready).toBe(false);
    expect(exited).not.toBe(0);
    // The corrupted bytes were preserved, not wiped/reinitialized over.
    expect(readFileSync(target).subarray(0, 64).toString("hex")).toBe(corruptedHash);
  }, 240_000);
});
