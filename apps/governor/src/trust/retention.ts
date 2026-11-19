import { signStoreGrant, STORE_RETENTION_ATTEMPT, type Digest } from "@brain/contracts";
import { rmSync } from "node:fs";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { log } from "../log";
import type { Governor } from "../app";
import { casPath } from "./artifacts";

/**
 * Retention (docs/model.md, "How long Brain keeps what is large"): the bytes of a goal that ended more than a week ago are forgotten: its files, diffs
 * and logs in the content store, the events of its attempts, and its states in the git store. What stays is the record: the tasks and their results,
 * the checks, the approvals with their digests, and the whole audit chain. A goal that has not ended is never touched.
 */
export const RETENTION_MS = 7 * 86_400_000;
const PER_ROUND = 20;

/** Forgets what the goals that ended before the cutoff hold; returns how many goals it forgot. */
export async function forgetEnded(gov: Gov): Promise<number> {
  const { db } = gov;
  const cutoff = gov.clock.nowMs() - RETENTION_MS;
  const goals = db.prepare(`SELECT id, workspace_id AS workspaceId FROM tasks WHERE id = root_id AND state IN ('done','failed','stopped') AND COALESCE(finished_at_ms, updated_at_ms) < ?
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type='retention.forgot' AND e.subject = 'task:' || tasks.id) ORDER BY updated_at_ms LIMIT ?`).all(cutoff, PER_ROUND) as Array<{ id: string; workspaceId: string }>;
  let forgot = 0;
  for (const goal of goals) {
    try {
      // The git store first: if it cannot be reached the goal is tried again at the next round, and nothing of it is half forgotten.
      if (gov.store) {
        const token = signStoreGrant({ workspaceId: goal.workspaceId, goalId: goal.id, attemptId: STORE_RETENTION_ATTEMPT, expiresAt: Math.floor(gov.clock.nowMs() / 1000) + 300 }, gov.store.privateKeyPem);
        const answer = await gov.fetch(`${gov.store.url}/${goal.workspaceId}/_goals/${goal.id}`, { method: "DELETE", signal: AbortSignal.timeout(120_000), headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } });
        if (!answer.ok) throw new Error(`the git store answered ${answer.status}`);
      }
      const gone = tx(db, () => {
        const tasks = (db.prepare("SELECT id FROM tasks WHERE root_id=?").all(goal.id) as Array<{ id: string }>).map((row) => row.id);
        const marks = tasks.map(() => "?").join(",");
        const attempts = (db.prepare(`SELECT id FROM attempts WHERE task_id IN (${marks})`).all(...tasks) as Array<{ id: string }>).map((row) => row.id);
        const attemptMarks = attempts.map(() => "?").join(",");
        const events = attempts.length === 0 ? 0 : db.prepare(`DELETE FROM attempt_events WHERE attempt_id IN (${attemptMarks})`).run(...attempts).changes;
        const digests = (db.prepare(`SELECT DISTINCT digest FROM artifact_links WHERE task_id IN (${marks})`).all(...tasks) as Array<{ digest: Digest }>).map((row) => row.digest);
        db.prepare(`DELETE FROM artifact_links WHERE task_id IN (${marks})`).run(...tasks);
        if (attempts.length > 0) db.prepare(`UPDATE attempts SET working_copy=NULL WHERE id IN (${attemptMarks})`).run(...attempts);
        // Bytes that another goal still names stay.
        const unnamed = digests.filter((digest) => !db.prepare("SELECT 1 FROM artifact_links WHERE digest=?").get(digest) && !db.prepare("SELECT 1 FROM attempts WHERE working_copy=?").get(digest));
        let bytes = 0;
        for (const digest of unnamed) {
          bytes += (db.prepare("SELECT bytes FROM artifacts WHERE digest=?").get(digest) as { bytes: number } | undefined)?.bytes ?? 0;
          db.prepare("DELETE FROM artifacts WHERE digest=?").run(digest);
        }
        append(db, { type: "retention.forgot", workspaceId: goal.workspaceId, subject: `task:${goal.id}`, payload: { events, artifacts: unnamed.length, bytes }, actor: SYSTEM });
        return unnamed;
      });
      for (const digest of gone) rmSync(casPath(gov.dataDir, digest), { force: true });
      forgot += 1;
    } catch (e) {
      log("warn", "retention.failed", { goal: goal.id, reason: e instanceof Error ? e.message : "unknown" });
    }
  }
  return forgot;
}

/** An hourly look at what ended more than a week ago. */
export function registerRetention(governor: Governor): void {
  governor.every(3_600_000, () => void forgetEnded(governor.gov));
}
