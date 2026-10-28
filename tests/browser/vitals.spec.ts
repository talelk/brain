import { test, expect } from "./fixtures";

test("web vitals: shell LCP, interaction latency, JS budget (E099 browser)", async ({ page, governor }, info) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __vitals: { lcp: number; inp: number; longTasks: number } };
    w.__vitals = { lcp: 0, inp: 0, longTasks: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__vitals.lcp = Math.max(w.__vitals.lcp, e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const ev = e as PerformanceEntry & { duration: number; processingStart?: number };
        w.__vitals.inp = Math.max(w.__vitals.inp, ev.duration);
      }
    }).observe({ type: "event", buffered: true });
    new PerformanceObserver((list) => {
      w.__vitals.longTasks += list.getEntries().length;
    }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  // Real interaction for INP: type into the setup form.
  await page.getByLabel(/^Organization name/).click();
  await page.keyboard.type("Vitals org", { delay: 10 });
  await page.waitForTimeout(600);
  const vitals = await page.evaluate(() => {
    const w = window as unknown as { __vitals: { lcp: number; inp: number; longTasks: number } };
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const jsBytes = resources.filter((r) => r.name.endsWith(".js")).reduce((n, r) => n + (r.encodedBodySize || r.transferSize || 0), 0);
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return { ...w.__vitals, jsBytes, domInteractive: nav ? nav.domInteractive : 0 };
  });
  info.annotations.push({ type: "vitals", description: JSON.stringify(vitals) });
  expect(vitals.lcp, `LCP ${vitals.lcp}ms`).toBeGreaterThan(0);
  expect(vitals.lcp, `LCP ${vitals.lcp}ms`).toBeLessThan(2500);
  expect(vitals.inp, `INP ${vitals.inp}ms`).toBeLessThan(200);
  expect(vitals.jsBytes, `initial JS ${vitals.jsBytes}B gzip-encoded`).toBeLessThan(250 * 1024);
});
