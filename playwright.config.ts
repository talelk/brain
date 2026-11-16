import { defineConfig, devices } from "@playwright/test";

/** `pnpm test:browser`: a first-time user in Chromium against a Governor and a runner that start inside the test (tests/browser/stack.ts). */
export default defineConfig({
  testDir: "tests/browser",
  outputDir: "test-results",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", locale: "en-GB" },
  projects: [
    { name: "desktop" },
    // The same first steps on a phone: only the tests that say so.
    { name: "phone", grep: /@phone/u, use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
});
