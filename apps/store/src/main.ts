import { readFileSync } from "node:fs";
import { startStore } from "./store";

/** The git store's process. Its environment variables are listed in docs/environment.md (packages/contracts/src/env.ts). */
const root = process.env["BRAIN_STORE_DIR"];
const keyFile = process.env["BRAIN_STORE_PUBLIC_KEY_FILE"];
if (!root || !keyFile) throw new Error("BRAIN_STORE_DIR and BRAIN_STORE_PUBLIC_KEY_FILE must be set");
const port = Number(process.env["PORT"] ?? 3110);
const host = process.env["BRAIN_BIND_HOST"] ?? "127.0.0.1";
const store = await startStore({ root, publicKeyPem: () => readFileSync(keyFile, "utf8") }, port, host);
process.stdout.write(`ts=${new Date().toISOString()} level=info event=store.listening host=${host} port=${store.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void store.close().then(() => process.exit(0)); });
