import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  use: { trace: "off" },
  projects: [
    ...[390,768,1440].flatMap((width) => (["light","dark"] as const).map((colorScheme) => ({
      name: `${width}-${colorScheme}`, use: { viewport: {width,height:900},colorScheme },
    }))),
    // Right-to-left: the browser language is Arabic, which makes the app set dir="rtl" (see apps/web/src/main.tsx; `?dir=rtl` forces it by hand).
    { name: "1440-light-rtl", testMatch: ["today", "mission-flow", "general-task", "needs-you", "library", "library-needs-person", "schedules", "operations", "busy-runner", "rtl"].map((name) => `**/${name}.spec.ts`), use: { viewport: {width:1440,height:900}, colorScheme: "light" as const, locale: "ar" } },
  ],
});
