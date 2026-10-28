// Phase 4: full interaction pass with a long-lived runner.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:3100";
const WS = "fixture-workspace";
const SHOTS = "/tmp/brain-review/shots";
const issues = []; const notes = []; const fails = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => issues.push({ where: page.url(), kind: "pageerror", detail: String(err).slice(0, 400) }));
page.on("response", async (res) => {
  if (res.status() >= 400 && res.url().includes("/v1/")) {
    let body = ""; try { body = (await res.text()).slice(0, 250); } catch {}
    fails.push({ status: res.status(), url: res.url(), body, referer: res.request().headers()["referer"] ?? "" });
  }
});
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

async function totp() {
  const { createHmac } = await import("node:crypto");
  const secret = "MVIDA2ZYOJ3WKRLYOFUECY2CONTXKUSHJJVXQNSMMFZFKY2RK4YQ";
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = ""; for (const ch of secret) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  return ((hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
await page.getByLabel("Email").fill("admin@review.test");
await page.getByLabel("Password").fill("review-password-123");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForTimeout(1200);
if (await page.getByLabel("Authenticator code").count()) {
  await page.getByLabel("Authenticator code").fill(await totp());
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForTimeout(1200);
}
// persist cookies for bash-side use
writeFileSync("/tmp/brain-review/cookies.txt", (await ctx.cookies(BASE)).map(c => `${c.name}=${c.value}`).join("; "));

// Mint a runner token and start a runner that survives this script (output to file).
const tok = await page.evaluate(async () => {
  const r = await fetch("/v1/runner-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: "fixture-tools" }) });
  return r.json();
});
const stateDir = mkdtempSync(join(tmpdir(), "runner-review4-"));
const child = spawn(process.execPath, [
  "/home/talel/dev/rd2026/brain/node_modules/.pnpm/tsx@4.20.6/node_modules/tsx/dist/cli.mjs",
  "/home/talel/dev/rd2026/brain/apps/runner/src/main.ts",
], {
  detached: true, stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, BRAIN_GOVERNOR_URL: BASE, BRAIN_RUNNER_ID: "runner-fixture-tools-2", BRAIN_RUNNER_STATE_DIR: stateDir, BRAIN_RUNNER_ENROLL_TOKEN: tok.token, BRAIN_RUNNER_GROUP: "fixture-tools", BRAIN_RUNNER_CAPABILITIES: "os:linux,arch:amd64,tool:bash,tool:python3,engine:claude,isolation:ephemeral-container" },
});
child.unref();
await new Promise((r) => setTimeout(r, 5000));

// --- Overview: open the Dispatch workflow panel.
await page.goto(`${BASE}/w/${WS}/overview`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await shot("50-overview-ready");
try {
  await page.getByRole("button", { name: /dispatch/i }).first().click();
  await page.waitForTimeout(700);
  await shot("51-dispatch-form");
  notes.push({ step: "dispatch-form", text: (await bodyText()).slice(0, 900) });
  // fill whatever inputs exist
  const inputs = page.locator("dialog input, [role=dialog] input, form input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) await inputs.nth(i).fill("hello from review").catch(() => {});
  const submit = page.getByRole("button", { name: /^dispatch$|submit|run|launch/i }).last();
  await submit.click();
  await page.waitForTimeout(2500);
  await shot("52-after-dispatch");
  notes.push({ step: "after-dispatch", text: (await bodyText()).slice(0, 900) });
} catch (e) { issues.push({ where: "dispatch", kind: "flow", detail: String(e).slice(0, 400) }); await shot("52-dispatch-failed"); }

// --- Runs page: find the run, open run detail.
await page.goto(`${BASE}/w/${WS}/runs`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await shot("53-runs-after-dispatch");
notes.push({ step: "runs-after-dispatch", text: (await bodyText()).slice(0, 900) });
const detailLink = page.locator("a[href*='/jobs/'], button:has-text('Open')").first();
if (await detailLink.count()) {
  await detailLink.click().catch(() => {});
  await page.waitForTimeout(1500);
} else {
  const m = (await bodyText()).match(/job-[a-z0-9-]+/i);
  if (m) { await page.goto(`${BASE}/jobs/${m[0]}`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1200); }
}
await shot("54-run-detail");
notes.push({ step: "run-detail", url: page.url(), text: (await bodyText()).slice(0, 900) });

// --- Board: create a card via dialog.
try {
  await page.goto(`${BASE}/w/${WS}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "New card" }).first().click();
  await page.waitForTimeout(500);
  await page.getByLabel(/title/i).fill("Review card");
  await page.getByLabel(/criteria/i).fill("The review finds real issues");
  await page.getByRole("button", { name: "Create card" }).click();
  await page.waitForTimeout(1500);
  await shot("55-board-with-card");
  notes.push({ step: "board-with-card", text: (await bodyText()).slice(0, 700) });
} catch (e) { issues.push({ where: "board-create", kind: "flow", detail: String(e).slice(0, 300) }); await shot("55-board-failed"); }

// --- Decisions: record go/no-go on the card.
try {
  await page.goto(`${BASE}/w/${WS}/decisions`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await shot("56-decisions");
  notes.push({ step: "decisions", text: (await bodyText()).slice(0, 700) });
} catch (e) { issues.push({ where: "decisions", kind: "flow", detail: String(e).slice(0, 300) }); }

// --- Tools: propose a tool.
try {
  await page.goto(`${BASE}/tools`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Propose tool" }).first().click();
  await page.waitForTimeout(600);
  await shot("57-propose-tool");
  notes.push({ step: "propose-tool", text: (await bodyText()).slice(0, 700) });
} catch (e) { issues.push({ where: "propose-tool", kind: "flow", detail: String(e).slice(0, 300) }); }

// --- Runners detail.
try {
  await page.goto(`${BASE}/runners`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const link = page.locator("a[href*='/runners/'], [role=row] button").first();
  if (await link.count()) { await link.click().catch(() => {}); await page.waitForTimeout(1200); }
  await shot("58-runner-detail");
  notes.push({ step: "runner-detail", url: page.url(), text: (await bodyText()).slice(0, 700) });
} catch (e) { issues.push({ where: "runner-detail", kind: "flow", detail: String(e).slice(0, 300) }); }

// --- Approvals (after dispatch there may be a pending approval).
await page.goto(`${BASE}/approvals`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await shot("59-approvals");
notes.push({ step: "approvals", text: (await bodyText()).slice(0, 700) });
const approvalLink = page.locator("a[href*='/approvals/']").first();
if (await approvalLink.count()) {
  await approvalLink.click().catch(() => {});
  await page.waitForTimeout(1500);
  await shot("60-approval-detail");
  notes.push({ step: "approval-detail", url: page.url(), text: (await bodyText()).slice(0, 900) });
}

writeFileSync("/tmp/brain-review/phase4-issues.json", JSON.stringify(issues, null, 2));
writeFileSync("/tmp/brain-review/phase4-notes.json", JSON.stringify(notes, null, 2));
writeFileSync("/tmp/brain-review/phase4-fails.json", JSON.stringify(fails, null, 2));
console.log("DONE issues:", issues.length, "fails:", fails.length);
for (const n of notes) { console.log("#####", n.step, "#####"); console.log(JSON.stringify(n).slice(0, 900)); }
for (const f of fails.slice(0, 12)) console.log(`HTTP ${f.status} ${f.url} from ${f.referer} :: ${f.body}`);
process.exit(0);
