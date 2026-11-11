import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@brain/contracts/validate": fileURLToPath(new URL("./packages/contracts/src/validate.ts", import.meta.url)),
      "@brain/contracts/machines": fileURLToPath(new URL("./packages/contracts/src/machines.ts", import.meta.url)),
      "@brain/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Cap parallel forks: each worker is ~400-570 MB and uncapped runs have OOM-killed the machine.
    maxWorkers: 4,
    testTimeout: Math.ceil(60000 * Math.max(1, Number(process.env["BRAIN_TEST_TIMEOUT_FACTOR"] ?? "1") || 1)),
    // Removes this run's disposable brain-test-* data directories once all workers finish.
    globalSetup: ["tests/support/temp-teardown.ts"],
  },
});
