/**
 * Reusable screenshot sweep for UI review. Starts a throwaway Governor on a temp dir (serving apps/web/dist,
 * or BRAIN_WEB_DIST_DIR), seeds the demo workspace used by the browser specs, then captures every screen
 * at the requested widths and colour schemes, full page, and reports pages that scroll sideways.
 *
 *   pnpm build
 *   (--viewport: one 390x844-style viewport shot per screen instead of the full page)
 *   TMPDIR=$HOME/.cache/tmp pnpm exec tsx scripts/capture-screens.ts [outDir] [--widths 1440,768,390] [--schemes light,dark] [--only today,logs]
 *
 * outDir defaults to ~/.cache/shots/<timestamp>. Files are <screen>-<width>-<scheme>.png. Look at them.
 * Nothing here is a test and nothing is written to the repository.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { chromium } from "@playwright/test";
import { createApp } from "../apps/governor/src/http/app";
import { seedBrowserDemo } from "../tests/support/browserDemo";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const outDir = positional[0] ?? join(homedir(), ".cache", "shots", new Date().toISOString().replace(/[:.]/g, "-"));
const widths = flag("widths", "1440,768,390").split(",").map(Number);
const schemes = flag("schemes", "light,dark").split(",") as Array<"light" | "dark">;
const viewportOnly = args.includes("--viewport");
const only = flag("only", "").split(",").filter(Boolean);

type Demo = Awaited<ReturnType<typeof seedBrowserDemo>>;
const SCREENS: Array<[string, (d: Demo) => string]> = [
  ["today", () => "/w/operations/today"],
  ["missions", () => "/w/operations/missions"],
  ["mission-new", () => "/w/operations/missions/new"],
  ["mission-live", (d) => `/missions/${d.seed.missionIds.active}/live`],
  ["mission-plan", (d) => `/missions/${d.seed.missionIds.active}/plan`],
  ["mission-outputs", (d) => `/missions/${d.seed.missionIds.active}/outputs`],
  ["mission-team", (d) => `/missions/${d.seed.missionIds.active}/team`],
  ["mission-brief", (d) => `/missions/${d.seed.missionIds.active}/brief`],
  ["mission-logs", (d) => `/missions/${d.seed.missionIds.active}/logs`],
  ["mission-closed", (d) => `/missions/${d.seed.missionIds.closed}/live`],
  ["library", () => "/w/operations/library"],
  ["plays", () => "/w/operations/plays?mode=catalog"],
  ["schedules", () => "/w/operations/schedules"],
  ["live", () => "/w/operations/live"],
  ["logs", () => "/w/operations/logs"],
  ["outputs", () => "/w/operations/outputs"],
  ["knowledge", () => "/w/operations/knowledge"],
  ["review-inbox", () => "/w/operations/knowledge/review"],
  ["approvals", () => "/approvals"],
  ["approval-review", (d) => `/approvals/${d.seed.approvalId}`],
  ["runners", () => "/runners"],
  ["quality", () => "/quality"],
  ["integrations", () => "/administration/integrations"],
  ["workspaces", () => "/administration/workspaces"],
  ["studio", () => "/studio/Agent"],
  ["tv", () => "/tv/sre"],
  ["ticket", (d) => `/tickets/${d.seed.ticketId}`],
  ["incident", (d) => `/incidents/${d.seed.incidentId}`],
  ...["setup", "security", "release", "people", "invitations", "members", "policy", "health"].map((tab): [string, (d: Demo) => string] => [`settings-${tab}`, () => `/settings?tab=${tab}`]),
];

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "brain-capture-"));
  const holder: { app?: Awaited<ReturnType<typeof createApp>> } = {};
  const server = createAdaptorServer({ fetch: (request) => holder.app ? holder.app.fetch(request) : new Response("starting", { status: 503 }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const url = `http://localhost:${address.port}`;
  process.env["BRAIN_BASE_URL"] = url;
  const app = await createApp({ dataDir: dir, runtime: { requireTwoFactor: false, memoryUiUrl: null } });
  holder.app = app;
  const browser = await chromium.launch();
  try {
    const credential = readFileSync(join(dir, "setup.token"), "utf8").trim();
    const setupPage = await (await browser.newContext()).newPage();
    const demo = await seedBrowserDemo(setupPage, { url, credential, app });
    // One signed-in storage state reused for every viewport/scheme.
    await setupPage.goto(`${url}/w/operations/today`);
    for (const scheme of schemes) for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      // sign in again through the seeded session cookie/token by reusing the setup page's storage
      await context.addCookies(await setupPage.context().cookies());
      const storage = await setupPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      await page.addInitScript((raw: string) => { const s = JSON.parse(raw) as { local: Record<string, string>; session: Record<string, string> }; for (const [k, v] of Object.entries(s.local)) localStorage.setItem(k, v); for (const [k, v] of Object.entries(s.session)) sessionStorage.setItem(k, v); }, storage);
      for (const [id, route] of SCREENS) {
        if (only.length && !only.includes(id)) continue;
        await page.goto(`${url}${route(demo)}`);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.waitForTimeout(500);
        if (viewportOnly) {
          // What a person sees without scrolling (390x844 is a phone): fixed bars are visible, nothing is grown.
          await page.setViewportSize({ width, height: 844 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(outDir, `${id}-${width}-${scheme}-vp.png`) });
          await page.setViewportSize({ width, height: 900 });
          continue;
        }
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        // The shell scrolls inside <main>, so a full-page shot would only show one viewport: grow the viewport to the tallest scroller.
        const tall = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 8 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY)).map((el) => el.scrollHeight + el.getBoundingClientRect().top)));
        await page.setViewportSize({ width, height: Math.min(Math.max(900, Math.ceil(tall)), 5000) });
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(outDir, `${id}-${width}-${scheme}.png`), fullPage: true });
        await page.setViewportSize({ width, height: 900 });
        if (sideways > 1) console.log(`SIDEWAYS ${id} ${width}-${scheme}: +${sideways}px`);
      }
      await context.close();
    }
    console.log(`captured to ${outDir}`);
  } finally {
    await browser.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
