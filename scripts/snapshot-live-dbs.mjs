// Runs INSIDE the Governor container (piped to `node -` by scripts/deploy-demo.sh).
// Writes a consistent, WAL-free snapshot of every live database to /tmp/precheck-snap using VACUUM INTO,
// so the pre-deploy schema check never copies a file that is being written.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dest = "/tmp/precheck-snap";
rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, "workspaces"), { recursive: true });
const sources = [["/data/control.db", join(dest, "control.db")]];
for (const file of readdirSync("/data/workspaces")) if (file.endsWith(".db")) sources.push([join("/data/workspaces", file), join(dest, "workspaces", file)]);
for (const [from, to] of sources) {
  const db = new DatabaseSync(from, { readOnly: true });
  try { db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`); } finally { db.close(); }
}
console.log(`snapshotted ${sources.length} databases`);
