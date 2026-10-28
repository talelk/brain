import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  use: { trace: "off" },
  projects: [390,768,1440].flatMap((width) => (["light","dark"] as const).map((colorScheme) => ({
    name: `${width}-${colorScheme}`, use: { viewport: {width,height:900},colorScheme },
  }))),
});
