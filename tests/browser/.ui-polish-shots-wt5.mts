/**
 * Throwaway visual-inspection harness for M5 (Knowledge + Studio + Capitalization).
 * Drives the seeded world from .ui-polish-world-wt5.mts (default :3125) across
 * 390/768/1440 in light/dark, performs a knowledge search, opens the review
 * (capitalization) tab, and captures Studio list/editor, asserting page-level
 * horizontal containment and writing full-page screenshots.
 *
 *   BRAIN_BASE_URL=http://127.0.0.1:3125 pnpm exec tsx tests/browser/.ui-polish-shots-wt5.mts
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env["BRAIN_BASE_URL"] ?? "http://127.0.0.1:3125";
const OUT = join(process.cwd(), "artifacts", "ui-polish", "screenshots");
const widths = [390, 768, 1440];
const themes = ["light", "dark"] as const;

async function loginCookie(context: import("@playwright/test").BrowserContext): Promise<void> {
  const res = await context.request.post(`${BASE}/api/auth/sign-in/email`, {
    data: { email: "operator@shots.test", password: "shots-password-123" },
    headers: { "content-type": "application/json" },
  });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
  const raw = res.headers()["set-cookie"] as string | undefined;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (!token) throw new Error("login did not return a session cookie");
  const host = new URL(BASE).hostname;
  await context.addCookies([{ name: "better-auth.session_token", value: decodeURIComponent(token), domain: host, path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function shot(page: import("@playwright/test").Page, dir: string, name: string): Promise<string> {
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  return `${name} overflow=${overflow}px`;
}

const browser = await chromium.launch();
const notes: string[] = [];
for (const width of widths) {
  for (const theme of themes) {
    const dir = join(OUT, `${width}-${theme}`);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    await loginCookie(context);
    const page = await context.newPage();
    page.on("pageerror", (e) => notes.push(`${width}-${theme} PAGEERROR ${e.message}`));

    // Knowledge — Find tab with results.
    await page.goto(`${BASE}/w/operations/knowledge`, { waitUntil: "networkidle" });
    await page.getByLabel("Search scoped knowledge").fill("runbook");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForTimeout(400);
    notes.push(await shot(page, dir, "knowledge-find"));

    // Knowledge — Review capability candidates tab (Capitalization Studio).
    await page.getByRole("radio", { name: "Review capability candidates", exact: true }).click();
    await page.waitForTimeout(500);
    notes.push(await shot(page, dir, "knowledge-review-capitalization"));

    // Studio list.
    await page.goto(`${BASE}/studio/Workflow`, { waitUntil: "networkidle" });
    notes.push(await shot(page, dir, "studio-list"));

    // Studio editor — open the seeded draft's editor link, then inspect.
    const draftLink = page.locator('a[href^="/studio/Workflow/"]').first();
    const hasDraft = await draftLink.isVisible().catch(() => false);
    if (hasDraft) {
      await draftLink.click();
      await page.waitForTimeout(500);
      const editorVisible = await page.getByRole("button", { name: "Save immutable revision", exact: true }).isVisible().catch(() => false);
      if (editorVisible) {
        await page.getByRole("button", { name: "Add job", exact: true }).click();
        await page.getByRole("button", { name: "Advanced YAML", exact: true }).click();
        notes.push(await shot(page, dir, "studio-editor-yaml"));
        await page.getByRole("button", { name: "Visual jobs", exact: true }).click();
        notes.push(await shot(page, dir, "studio-editor-visual"));
      } else {
        notes.push(`${width}-${theme} studio-editor SKIPPED (editor not reachable)`);
      }
    } else {
      notes.push(`${width}-${theme} studio-editor SKIPPED (no draft in world)`);
    }

    await context.close();
  }
}
await browser.close();
console.log(notes.join("\n"));
console.log(`\nScreenshots in ${OUT}`);
