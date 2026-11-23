import { serve } from "@hono/node-server";
import { createGovernor } from "./app";
import { log } from "./log";

/**
 * The Governor's environment variables, all of them:
 *   BRAIN_DATA_DIR                 the directory Brain keeps its data in (required)
 *   PORT                           the port to listen on (default 3100)
 *   BRAIN_BIND_HOST                the addresses to listen on, comma-separated (default 127.0.0.1)
 *   BRAIN_BASE_URL                 the address people reach Brain at (default http://localhost:<port>)
 *   BRAIN_GATEWAY_URL              the address engines reach the model gateway at, when sandboxes cannot use the base address
 *   BRAIN_STORE_URL                the address runners reach the git store at (apps/store); without it an attempt that needs the store fails
 *   BRAIN_PACKS_DIR                the packs directory (default the one shipped with Brain)
 *   LOG_LEVEL                      the least level logged: debug, info, warn or error (default info)
 *   BRAIN_METRICS_TOKEN            the bearer token GET /metrics asks for; without it the route answers 404
 *   BRAIN_LOCAL_RUNNER_TOKEN_FILE  where to leave a one-use runner token while no runner is enrolled
 */
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
