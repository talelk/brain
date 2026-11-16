import { serve } from "@hono/node-server";
import { createGovernor } from "./app";

const port = Number(process.env["PORT"] ?? 3100);
const hostname = process.env["BRAIN_BIND_HOST"] ?? "127.0.0.1";
const dataDir = process.env["BRAIN_DATA_DIR"];
if (!dataDir) throw new Error("BRAIN_DATA_DIR must name the directory Brain keeps its data in");

const governor = await createGovernor({
  dataDir,
  baseUrl: process.env["BRAIN_BASE_URL"] ?? `http://localhost:${port}`,
  ...(process.env["BRAIN_PACKS_DIR"] ? { packsDir: process.env["BRAIN_PACKS_DIR"] } : {}),
});
const server = serve({ fetch: governor.app.fetch, port, hostname }, () => console.log(`Brain is listening on http://${hostname}:${port}`));
governor.startTimers();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    governor.close();
    process.exit(0);
  });
}
