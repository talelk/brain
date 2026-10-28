// Phase 2: query failure bodies, TOTP completion, board card, tools, runner detail.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3100";
const WS = "ws-review";
const SHOTS = "/tmp/brain-review/shots";
mkdirSync(SHOTS, { recursive: true });
const issues = []; const notes = []; const queryFails = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => issues.push({ where: page.url(), kind: "pageerror", detail: String(err).slice(0, 400) }));
page.on("response", async (res) => {
  if (res.status() >= 400 && res.url().includes("/v1/")) {
    let body = "";
    try { body = (await res.text()).slice(0, 400); } catch {}
    queryFails.push({ status: res.status(), url: res.url(), body, referer: res.request().headers()["referer"] ?? "" });
  }
});
async function shot(name) { await page.screenshot({ path: `${SHOTS}/${name}.png` }); }

// Session cookie persisted? context is new, so sign in again.
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
if (await page.getByLabel("Email").count()) {
  await page.getByLabel("Email").fill("admin@review.test");
  await page.getByLabel("Password").fill("review-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(1500);
}
notes.push({ step: "signed-in", text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200) });

// TOTP enrollment: confirm password first, then read otpauth URI, verify code.
async function totpNow(secretB32) {
  const { createHmac } = await import("node:crypto");
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = ""; for (const ch of secretB32.replace(/=+$/, "")) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  return ((hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
try {
  const section = page.locator("section[aria-label='Authenticator setup']");
  await section.getByLabel("Confirm password").fill("review-password-123");
  await section.getByRole("button", { name: "Begin setup" }).click();
  await section.locator("a[href^='otpauth']").waitFor({ timeout: 8000 });
  const uri = await section.locator("a[href^='otpauth']").getAttribute("href");
  const secret = new URL(uri).searchParams.get("secret");
  const backup = (await section.locator("pre").innerText()).split("\n").map(s => s.trim()).filter(Boolean);
  notes.push({ step: "totp-secret", secret, backup });
  await section.getByLabel("Authenticator code").fill(await totpNow(secret));
  await section.getByRole("button", { name: "Verify authenticator" }).click();
  await page.waitForTimeout(1500);
  await shot("30-totp-done");
  notes.push({ step: "totp-done", text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300) });
} catch (e) {
  issues.push({ where: "totp", kind: "flow", detail: String(e).slice(0, 400) });
  await shot("30-totp-failed");
}

// Board: create a card through the UI.
try {
  await page.goto(`${BASE}/w/${WS}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "New card" }).first().click();
  await page.waitForTimeout(600);
  await shot("31-board-newcard-dialog");
  notes.push({ step: "board-dialog", text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700) });
} catch (e) { issues.push({ where: "board-new-card", kind: "flow", detail: String(e).slice(0, 300) }); }

// Knowledge: run a memory search (this may be the 503 source).
try {
  await page.goto(`${BASE}/w/${WS}/knowledge`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const searchBox = page.getByLabel(/search/i).first();
  await searchBox.fill("hello");
  await page.getByRole("button", { name: /search/i }).first().click();
  await page.waitForTimeout(2500);
  await shot("32-knowledge-search");
  notes.push({ step: "knowledge-search", text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 500) });
} catch (e) { issues.push({ where: "knowledge-search", kind: "flow", detail: String(e).slice(0, 300) }); }

// Overview: dispatch workflow availability + release panel.
try {
  await page.goto(`${BASE}/w/${WS}/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await shot("33-overview");
} catch (e) { issues.push({ where: "overview", kind: "flow", detail: String(e).slice(0, 300) }); }

// Settings: full page + members form
try {
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await shot("34-settings");
  const audit = await page.getByText(/audit/i).first().isVisible().catch(() => false);
  notes.push({ step: "settings", auditVisible: audit });
} catch (e) { issues.push({ where: "settings", kind: "flow", detail: String(e).slice(0, 300) }); }

writeFileSync("/tmp/brain-review/phase2-issues.json", JSON.stringify(issues, null, 2));
writeFileSync("/tmp/brain-review/phase2-notes.json", JSON.stringify(notes, null, 2));
writeFileSync("/tmp/brain-review/query-fails.json", JSON.stringify(queryFails, null, 2));
console.log("issues:", issues.length, "queryFails:", queryFails.length);
for (const q of queryFails.slice(0, 12)) console.log(`HTTP ${q.status} ${q.url}\n  from ${q.referer}\n  body ${q.body}\n`);
await browser.close();
