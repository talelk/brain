// Runs INSIDE the Governor container (piped to `node - <command>` by scripts/deploy-demo.sh): drain mode for deploys that do not
// interrupt work. `on` stops new attempts from being offered and automatic starts, `wait [seconds]` does that and then waits for the
// running attempts to finish, `off` resumes, `status` only reports. Exit codes: 0 done, 3 attempts still running at the timeout.
// The flag lives in control.db (platform_state), so it survives the container being replaced: resume is a separate, explicit step.
import { DatabaseSync } from "node:sqlite";

const [command = "status", secondsArg = "600"] = process.argv.slice(2);
const dataDir = process.env["BRAIN_DATA_DIR"] ?? "/data";
const db = new DatabaseSync(`${dataDir}/control.db`);
db.exec("PRAGMA busy_timeout = 5000");

const hasTable = () => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='platform_state'").get() !== undefined;
const running = () => db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('offered','running','uploading','cancelling','verifying')").get().n;
const queued = () => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get().n;
const draining = () => (hasTable() ? db.prepare("SELECT draining FROM platform_state WHERE singleton=1").get()?.draining === 1 : false);
const set = (on) => {
  // A Governor that predates drain mode has no flag to set: report it, and fall back to waiting on the running attempts only.
  if (!hasTable()) return false;
  db.prepare(`INSERT INTO platform_state(singleton,draining,changed_by,changed_at_ms) VALUES (1,?,'deploy',?)
    ON CONFLICT(singleton) DO UPDATE SET draining=excluded.draining,changed_by='deploy',changed_at_ms=excluded.changed_at_ms`).run(on ? 1 : 0, Date.now());
  return true;
};
const status = (extra = {}) => console.log(JSON.stringify({ supported: hasTable(), draining: draining(), runningAttempts: running(), queuedJobs: queued(), ...extra }));

let code = 0;
try {
  if (command === "on") { const ok = set(true); status({ changed: ok }); }
  else if (command === "off") { const ok = set(false); status({ changed: ok }); }
  else if (command === "wait") {
    const ok = set(true);
    const deadline = Date.now() + Number(secondsArg) * 1000;
    while (running() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000));
    status({ changed: ok, idle: running() === 0 });
    if (running() > 0) code = 3;
  } else status();
} finally { db.close(); }
process.exit(code);
