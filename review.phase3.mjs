// Phase 3: activate golden release, enroll runner, dispatch from UI, detail pages.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3100";
const SHOTS = "/tmp/brain-review/shots";
const issues = []; const notes = []; const fails = [];

const files = ["fixture-brain.yaml","fixture-policy.yaml","fixture-type.yaml","fixture-tools.yaml","fixture-evaluators.yaml","fixture.echo.yaml","fixture.verify.yaml","fixture-evaluator.yaml","fixture-workflow.yaml","fixture-workspace.yaml"];
const docs = files.map((f) => ({ path: `config/${f}`, text: readFileSync(join("/home/talel/dev/rd2026/brain/examples/v1/golden-release/config", f), "utf8") }));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => issues.push({ where: page.url(), kind: "pageerror", detail: String(err).slice(0, 400) }));
page.on("response", async (res) => {
  if (res.status() >= 400 && res.url().includes("/v1/")) {
    let body = ""; try { body = (await res.text()).slice(0, 300); } catch {}
    fails.push({ status: res.status(), url: res.url(), body, referer: res.request().headers()["referer"] ?? "" });
  }
});
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
if (await page.getByLabel("Email").count()) {
  await page.getByLabel("Email").fill("admin@review.test");
  await page.getByLabel("Password").fill("review-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(1200);
}

// TOTP code may now be required at sign-in; if a code field appeared, handle it.
// (enrolled in phase 2 with trustDevice:false, so 2FA is asked every sign-in)
const codeBox = page.getByLabel("Authenticator code");
if (await codeBox.count()) {
  const { createHmac } = await import("node:crypto");
  const secret = "MVIDA2ZYOJ3WKRLYOFUECY2CONTXKUSHJJVXQNSMMFZFKY2RK4YQ";
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = ""; for (const ch of secret) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  await codeBox.fill(((hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0"));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForTimeout(1200);
}

// Stage + activate the golden release, add its workspace, mint a runner token.
const setup = await page.evaluate(async (docs) => {
  const out = {};
  const rev = "sha256:" + "a".repeat(64);
  const cfg = await fetch("/v1/setup/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documents: docs, sourceRevision: rev, activate: true }) });
  out.config = { status: cfg.status, body: (await cfg.text()).slice(0, 200) };
  const ws = await fetch("/v1/setup/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "fixture-workspace", slug: "Fixture" }) });
  out.ws = { status: ws.status, body: (await ws.text()).slice(0, 200) };
  const tok = await fetch("/v1/runner-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: "fixture-tools" }) });
  out.token = { status: tok.status, body: (await tok.text()).slice(0, 200) };
  return out;
}, docs);
notes.push({ step: "setup-api", ...setup });
const runnerToken = JSON.parse(setup.token.body || "{}").token ?? "";

// Start a real runner against this governor.
if (runnerToken) {
  const { execa } = await import("execa").catch(() => ({}));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [
    "/home/talel/dev/rd2026/brain/node_modules/.pnpm/tsx@4.20.6/node_modules/tsx/dist/cli.mjs",
    "apps/runner/src/main.ts",
  ], {
    cwd: "/home/talel/dev/rd2026/brain",
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BRAIN_GOVERNOR_URL: BASE, BRAIN_RUNNER_ID: "runner-fixture-tools-1", BRAIN_RUNNER_STATE_DIR: mkdtempSync(join(tmpdir(), "runner-review-")), BRAIN_RUNNER_ENROLL_TOKEN: runnerToken, BRAIN_RUNNER_GROUP: "fixture-tools", BRAIN_RUNNER_CAPABILITIES: "os:linux,arch:amd64,tool:bash,tool:python3,engine:claude,isolation:ephemeral-container" },
  });
  child.unref();
  const log = []; child.stdout.on("data", (d) => log.push(String(d).slice(0, 400))); child.stderr.on("data", (d) => log.push(String(d).slice(0, 400)));
  await new Promise((r) => setTimeout(r, 4000));
  notes.push({ step: "runner-log", log: log.join("").slice(0, 800) });
}

// Walk pages that previously 503'd + runs/tools with release active.
for (const [name, path] of [
  ["40-overview-fixture", "/w/fixture-workspace/overview"],
  ["41-overview-wsreview", "/w/ws-review/overview"],
  ["42-settings", "/settings"],
  ["43-runs-fixture", "/w/fixture-workspace/runs"],
  ["44-tools", "/tools"],
]) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  await shot(name);
  notes.push({ step: name, text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700) });
}

writeFileSync("/tmp/brain-review/phase3-issues.json", JSON.stringify(issues, null, 2));
writeFileSync("/tmp/brain-review/phase3-notes.json", JSON.stringify(notes, null, 2));
writeFileSync("/tmp/brain-review/phase3-fails.json", JSON.stringify(fails, null, 2));
console.log("issues:", issues.length, "fails:", fails.length);
for (const n of notes) { console.log("#####", n.step, "#####"); console.log(JSON.stringify(n).slice(0, 900)); }
for (const f of fails.slice(0, 10)) console.log(`HTTP ${f.status} ${f.url} from ${f.referer} :: ${f.body}`);
await browser.close();
