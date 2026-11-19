import { readFileSync } from "node:fs";
import { startStore } from "./store";

/**
 * The git store's environment variables, all of them:
 *   BRAIN_STORE_DIR              where the repositories are kept (required)
 *   BRAIN_STORE_PUBLIC_KEY_FILE  the Governor's `store.pub` (required)
 *   PORT                         the port to listen on (default 3110)
 *   BRAIN_BIND_HOST              the address to listen on (default 127.0.0.1)
 */
const root = process.env["BRAIN_STORE_DIR"];
const keyFile = process.env["BRAIN_STORE_PUBLIC_KEY_FILE"];
if (!root || !keyFile) throw new Error("BRAIN_STORE_DIR and BRAIN_STORE_PUBLIC_KEY_FILE must be set");
const port = Number(process.env["PORT"] ?? 3110);
const host = process.env["BRAIN_BIND_HOST"] ?? "127.0.0.1";
const store = await startStore({ root, publicKeyPem: () => readFileSync(keyFile, "utf8") }, port, host);
process.stdout.write(`ts=${new Date().toISOString()} level=info event=store.listening host=${host} port=${store.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void store.close().then(() => process.exit(0)); });
