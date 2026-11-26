import { serve } from "@hono/node-server";
import { createGovernor } from "./app";
import { log } from "./log";

/** The Governor's process. Its environment variables are listed in docs/environment.md (packages/contracts/src/env.ts). */
const port = Number(process.env["PORT"] ?? 3100);
const hostnames = (process.env["BRAIN_BIND_HOST"] ?? "127.0.0.1").split(",").map((entry) => entry.trim()).filter(Boolean);
const dataDir = process.env["BRAIN_DATA_DIR"];
if (!dataDir) throw new Error("BRAIN_DATA_DIR must name the directory Brain keeps its data in");

const governor = await createGovernor({
  dataDir,
  baseUrl: process.env["BRAIN_BASE_URL"] ?? `http://localhost:${port}`,
  ...(process.env["BRAIN_GATEWAY_URL"] ? { gatewayUrl: process.env["BRAIN_GATEWAY_URL"] } : {}),
  ...(process.env["BRAIN_STORE_URL"] ? { storeUrl: process.env["BRAIN_STORE_URL"] } : {}),
  ...(process.env["BRAIN_PACKS_DIR"] ? { packsDir: process.env["BRAIN_PACKS_DIR"] } : {}),
  ...(process.env["BRAIN_LOCAL_RUNNER_TOKEN_FILE"] ? { localRunnerTokenFile: process.env["BRAIN_LOCAL_RUNNER_TOKEN_FILE"] } : {}),
});
const servers = hostnames.map((hostname) => serve({ fetch: governor.app.fetch, port, hostname }, () => log("info", "governor.listening", { host: hostname, port, node: process.version })));
governor.startTimers();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const server of servers) server.close();
    governor.close();
    process.exit(0);
  });
}
