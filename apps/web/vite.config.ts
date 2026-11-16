import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// `pnpm dev` expects a Governor on its default port; BRAIN_GOVERNOR_URL points the proxy elsewhere.
const governor = process.env["BRAIN_GOVERNOR_URL"] ?? "http://127.0.0.1:3100";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target: governor, changeOrigin: false },
      "/api/auth": { target: governor, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
