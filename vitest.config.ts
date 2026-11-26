import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@brain/contracts/limits": fileURLToPath(new URL("./packages/contracts/src/limits.ts", import.meta.url)), "@brain/contracts/packs": fileURLToPath(new URL("./packages/contracts/src/packs.ts", import.meta.url)), "@brain/contracts/engines": fileURLToPath(new URL("./packages/contracts/src/engines.ts", import.meta.url)), "@brain/contracts/validate": fileURLToPath(new URL("./packages/contracts/src/validate.ts", import.meta.url)), "@brain/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/core/**/*.test.ts", "tests/runner/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    // Each worker is a few hundred megabytes; more than four have exhausted the machine's memory.
    maxWorkers: 4,
    testTimeout: 60_000,
  },
});
