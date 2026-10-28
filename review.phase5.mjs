// Phase 5: proper dispatch, run detail, approval, runner detail, decisions, members, direct detail URLs.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

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

// --- Dispatch for real: select workflow, fill message, dispatch.
await page.goto(`${BASE}/w/${WS}/overview`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "Dispatch workflow" }).click();
await page.waitForTimeout(600);
await page.getByRole("button", { name: /fixture-workflow/ }).first().click();
await page.getByLabel("Input message").fill("hello from the review");
await shot("60-dispatch-filled");
await page.getByRole("button", { name: "Dispatch", exact: true }).click();
await page.waitForTimeout(2500);
await shot("61-after-dispatch");
notes.push({ step: "after-dispatch", url: page.url(), text: (await bodyText()).slice(0, 1000) });

// --- Run detail (should have navigated to /jobs/:id).
const jobUrl = page.url().includes("/jobs/") ? page.url() : "";
if (!jobUrl) {
  await page.goto(`${BASE}/w/${WS}/runs`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const open = page.getByRole("button", { name: "Open" }).first();
  if (await open.count()) { await open.click(); await page.waitForTimeout(1500); }
}
await page.waitForTimeout(2500); // let attempts progress
await shot("62-run-detail");
notes.push({ step: "run-detail", url: page.url(), text: (await bodyText()).slice(0, 1200) });

// --- Runner detail via list button.
await page.goto(`${BASE}/runners`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
const det = page.getByRole("button", { name: "Details" }).first();
if (await det.count()) { await det.click(); await page.waitForTimeout(1500); }
await shot("63-runner-detail");
notes.push({ step: "runner-detail", url: page.url(), text: (await bodyText()).slice(0, 800) });

// --- Direct detail URLs with unknown ids (must show clean not-found, not crash).
for (const [name, path] of [
  ["64-job-unknown", "/jobs/job-does-not-exist"],
  ["65-approval-unknown", "/approvals/apr-does-not-exist"],
  ["66-ticket-unknown", "/tickets/tkt-does-not-exist"],
  ["67-incident-unknown", "/incidents/inc-does-not-exist"],
  ["68-session-unknown", "/sessions/ses-does-not-exist"],
  ["69-runner-unknown", "/runners/runner-does-not-exist"],
]) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await shot(name);
  notes.push({ step: name, text: (await bodyText()).replace(/^.*?Skip to workspace/, "").slice(0, 300) });
}

// --- Decisions: record a decision for the known card.
await page.goto(`${BASE}/w/${WS}/decisions`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
const cardMatch = (await bodyText()).match(/card-[a-z0-9-]+/i);
if (cardMatch) {
  await page.getByLabel(/card id/i).first().fill(cardMatch[0]).catch(() => {});
  await page.getByRole("button", { name: "Go", exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Record decision" }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
}
await shot("70-decision-recorded");
notes.push({ step: "decision", text: (await bodyText()).slice(0, 600) });

// --- Settings: member grant form.
await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await shot("71-settings-full");
notes.push({ step: "settings-full", text: (await bodyText()).slice(0, 1500) });

writeFileSync("/tmp/brain-review/phase5-issues.json", JSON.stringify(issues, null, 2));
writeFileSync("/tmp/brain-review/phase5-notes.json", JSON.stringify(notes, null, 2));
writeFileSync("/tmp/brain-review/phase5-fails.json", JSON.stringify(fails, null, 2));
console.log("DONE issues:", issues.length, "fails:", fails.length);
for (const n of notes) { console.log("#####", n.step, "#####"); console.log(JSON.stringify(n).slice(0, 1100)); }
for (const f of fails.slice(0, 14)) console.log(`HTTP ${f.status} ${f.url} from ${f.referer} :: ${f.body}`);
process.exit(0);
