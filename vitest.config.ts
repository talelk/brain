import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@brain/contracts/validate": fileURLToPath(new URL("./packages/contracts/src/validate.ts", import.meta.url)),
      "@brain/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
