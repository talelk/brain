// Runs INSIDE the Governor container (piped to `node -` by scripts/deploy-demo.sh).
// Prints the number of attempts that a deploy would interrupt.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/data/control.db", { readOnly: true });
try {
  const row = db.prepare("SELECT COUNT(*) AS count FROM job_attempts WHERE state IN ('offered','running','uploading','cancelling','verifying')").get();
  console.log(row.count);
} finally { db.close(); }
