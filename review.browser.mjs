// Temporary full-review driver: walks every UI route, harvests console,
// page errors and HTTP failures, and drops screenshots to /tmp/brain-review.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3100";
const WS = "ws-review";
const SHOTS = "/tmp/brain-review/shots";
mkdirSync(SHOTS, { recursive: true });

const token = readFileSync("/tmp/brain-review-data/setup.token", "utf8").trim();
const issues = []; // { where, kind, detail }
const notes = [];

function track(where) {
  return {
    console: (msg) => { if (msg.type() === "error" || msg.type() === "warning") issues.push({ where, kind: `console.${msg.type()}`, detail: msg.text().slice(0, 500) }); },
    pageerror: (err) => issues.push({ where, kind: "pageerror", detail: String(err).slice(0, 500) }),
    response: (res) => { if (res.status() >= 400) issues.push({ where, kind: `http.${res.status()}`, detail: `${res.request().method()} ${res.url()}`.slice(0, 300) }); },
    requestfailed: (req) => issues.push({ where, kind: "requestfailed", detail: `${req.method()} ${req.url()} :: ${req.failure()?.errorText}`.slice(0, 300) }),
  };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const t = track("global");
page.on("console", t.console); page.on("pageerror", t.pageerror);
page.on("response", t.response); page.on("requestfailed", t.requestfailed);

async function shot(name) { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); }
async function waitReady() { await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(700); }

// ---------- Phase 1: fresh setup wizard ----------
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await waitReady();
await shot("01-setup-initial");
const formText = await page.locator("body").innerText();
notes.push({ step: "setup-screen", text: formText.slice(0, 600) });

await page.getByLabel("Setup credential").fill(token);
await page.getByLabel("Organization name").fill("Review Org");
await page.getByLabel("Organization ID").fill("review");
await page.getByLabel("Email").fill("admin@review.test");
await page.getByLabel("Password").fill("review-password-123");
await page.getByRole("button", { name: "Create organization" }).click();
await page.waitForTimeout(1500);
await shot("02-after-bootstrap");
notes.push({ step: "after-bootstrap", text: (await page.locator("body").innerText()).slice(0, 800) });

// ---------- Phase 2: workspace provisioning (API exists; UI may not) ----------
const wsResponse = await page.evaluate(async ({ ws, slug }) => {
  const r = await fetch("/v1/setup/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: ws, slug }) });
  return { status: r.status, body: await r.text() };
}, { ws: WS, slug: "Review WS" });
notes.push({ step: "create-workspace-api", text: JSON.stringify(wsResponse).slice(0, 300) });
await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" });
await waitReady();
await shot("03-today");
notes.push({ step: "today", text: (await page.locator("body").innerText()).slice(0, 1200) });

// ---------- Phase 3: TOTP enrollment (generate code locally) ----------
async function totpNow(secretB32) {
  const { createHmac } = await import("node:crypto");
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = ""; for (const ch of secretB32.replace(/=+$/, "")) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

let backupCodes = [];
try {
  await page.getByRole("button", { name: "Begin setup" }).click();
  await page.waitForTimeout(1000);
  const section = page.locator("section[aria-label='Authenticator setup']");
  const uri = await section.locator("a[href^='otpauth']").first().getAttribute("href");
  const secret = new URL(uri).searchParams.get("secret");
  backupCodes = (await section.locator("pre").innerText()).split("\n").map(s => s.trim()).filter(Boolean);
  notes.push({ step: "totp", secret, backupCodes });
  const code = await totpNow(secret);
  await section.getByLabel("Authenticator code").fill(code);
  await section.getByRole("button", { name: "Verify authenticator" }).click();
  await page.waitForTimeout(1200);
  await shot("04-after-totp");
} catch (e) {
  issues.push({ where: "totp-enrollment", kind: "flow", detail: String(e).slice(0, 400) });
  await shot("04-after-totp-failed");
}

// ---------- Phase 4: walk all shell routes ----------
const routes = [
  ["today", "/today"],
  ["bridge", "/bridge"],
  ["overview", `/w/${WS}/overview`],
  ["board", `/w/${WS}/board`],
  ["decisions", `/w/${WS}/decisions`],
  ["runs", `/w/${WS}/runs`],
  ["support", `/w/${WS}/support`],
  ["sre", `/w/${WS}/sre`],
  ["delivery", `/w/${WS}/delivery`],
  ["knowledge", `/w/${WS}/knowledge`],
  ["approvals", "/approvals"],
  ["runners", "/runners"],
  ["tools", "/tools"],
  ["settings", "/settings"],
  ["tv-support", "/tv/support"],
  ["tv-sre", "/tv/sre"],
];
const routeText = {};
for (const [name, path] of routes) {
  const local = track(name);
  const p2 = page; // same tab; listeners above already global
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shot(`10-${name}`);
  try { routeText[name] = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 900); } catch { routeText[name] = "<innerText failed>"; }
}
writeFileSync("/tmp/brain-review/route-text.json", JSON.stringify(routeText, null, 2));

// ---------- Phase 5: interactions ----------
// theme toggle
try {
  await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" }); await waitReady();
  const themeBtn = page.getByRole("button", { name: /theme|dark|light/i }).first();
  await themeBtn.click(); await page.waitForTimeout(400);
  await shot("20-theme-toggled");
} catch (e) { issues.push({ where: "theme-toggle", kind: "flow", detail: String(e).slice(0, 300) }); }

// narrow viewport sanity
try {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" }); await waitReady();
  await shot("21-mobile-today");
  await page.setViewportSize({ width: 1440, height: 900 });
} catch (e) { issues.push({ where: "mobile", kind: "flow", detail: String(e).slice(0, 300) }); }

// sign out & sign in
try {
  await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" }); await waitReady();
  await page.getByTestId("account-menu").getByRole("button").first().click();
  await page.waitForTimeout(300);
  await page.getByText("Sign out", { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await shot("22-signed-out");
  await page.getByLabel("Email").fill("admin@review.test");
  await page.getByLabel("Password").fill("review-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(1500);
  await shot("23-signed-back-in");
} catch (e) { issues.push({ where: "signout-signin", kind: "flow", detail: String(e).slice(0, 300) }); await shot("23-signin-failed"); }

writeFileSync("/tmp/brain-review/issues.json", JSON.stringify(issues, null, 2));
writeFileSync("/tmp/brain-review/notes.json", JSON.stringify(notes, null, 2));
console.log("ISSUES:", issues.length);
for (const i of issues) console.log(`- [${i.where}] ${i.kind}: ${i.detail}`);
await browser.close();
