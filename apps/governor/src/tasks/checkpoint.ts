import { CHECKPOINT } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { COST } from "../trust/usage";
import { manifestOf } from "../workspace/store";
import { needOf, setState, taskOf, type TaskRow } from "./store";

/** A goal pauses for a person as its Play or `[limits]` says (docs/model.md, "Checkpoints"). */
const HOUR_MS = 3_600_000;
const WAITING = "state='needs_you' AND json_extract(needs_json, '$.kind')='checkpoint'";

/** How the goal is set to pause: hours or work attempts; null when it is not. */
function settingOf(gov: Gov, root: TaskRow): { hours: number | null; rounds: number | null; timeoutHours: number } | null {
  const manifest = manifestOf(gov, root.snapshot_digest);
  const text = root.play !== null ? manifest.plays[root.play]?.checkpoint : manifest.limits.checkpoint;
  const found = text === undefined ? null : CHECKPOINT.exec(text);
  if (!found) return null;
  const n = Number(found[1]);
  return { hours: found[2] === "h" ? n : null, rounds: found[2] === "h" ? null : n, timeoutHours: Number.parseInt(manifest.limits.checkpoint_timeout, 10) };
}

/** The work attempts the goal has made in all. */
const attemptsOf = (gov: Gov, root: TaskRow): number =>
  (gov.db.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.root_id=? AND a.kind='work'").get(root.id) as { n: number }).n;

/** When the goal last continued from a checkpoint (or started), and how many work attempts it had made then. */
function sinceOf(gov: Gov, root: TaskRow): { at: number; attempts: number } {
  const last = gov.db.prepare("SELECT created_at_ms AS at, payload_json AS payload FROM events WHERE subject=? AND type='task.checkpointed' ORDER BY seq DESC LIMIT 1").get(`task:${root.id}`) as { at: number; payload: string } | undefined;
  return last ? { at: last.at, attempts: (JSON.parse(last.payload) as { attempts: number }).attempts } : { at: root.created_at_ms, attempts: 0 };
}

/**
 * Called before a ready task is started. True when it must not start: its goal has a checkpoint open, or is due one, in which case this task
 * becomes the one that needs a person (the others of the goal wait, ready, until it is answered).
 */
export function holdForCheckpoint(gov: Gov, task: TaskRow): boolean {
  const root = taskOf(gov.db, task.root_id);
  const setting = settingOf(gov, root);
  if (!setting) return false;
  if (gov.db.prepare(`SELECT 1 FROM tasks WHERE root_id=? AND ${WAITING}`).get(root.id)) return true;
  const now = gov.clock.nowMs();
  const since = sinceOf(gov, root);
  const attempts = attemptsOf(gov, root) - since.attempts;
  const hours = (now - since.at) / HOUR_MS;
  if (!((setting.hours !== null && hours >= setting.hours) || (setting.rounds !== null && attempts >= setting.rounds))) return false;
  const spent = (gov.db.prepare(`SELECT COALESCE(SUM(${COST}), 0) AS n FROM usage u JOIN tasks t ON t.id=u.task_id WHERE t.root_id=?`).get(root.id) as { n: number }).n;
  const note = gov.db.prepare("SELECT text FROM notes WHERE root_id=? ORDER BY id DESC LIMIT 1").get(root.id) as { text: string } | undefined;
  const summary = `Since ${new Date(since.at).toISOString().slice(0, 16).replace("T", " ")} UTC: ${attempts} work attempt${attempts === 1 ? "" : "s"}, ${hours.toFixed(1)} hours, $${(spent / 1_000_000).toFixed(2)} spent on the goal in all.${note ? ` Latest note: ${note.text.slice(0, 400)}` : ""}`;
  setState(gov, task, "needs_you", { need: { kind: "checkpoint", summary, until: now + setting.timeoutHours * HOUR_MS } });
  return true;
}

/** A person answers a checkpoint: the clock restarts, and a changed goal is written as a note every attempt of the goal reads. */
export function continueCheckpoint(gov: Gov, root: TaskRow, by: string, goal: string | undefined): void {
  const { db } = gov;
  if (goal !== undefined) db.prepare("INSERT INTO notes(workspace_id, root_id, author, attempt_id, text, created_at_ms) VALUES (?,?,?,?,?,?)").run(root.workspace_id, root.id, by, null, `Checkpoint: the goal is now: ${goal}`, gov.clock.nowMs());
  append(db, { type: "task.checkpointed", workspaceId: root.workspace_id, subject: `task:${root.id}`, payload: { changed: goal !== undefined, title: root.title, attempts: attemptsOf(gov, root) }, actor: SYSTEM });
  for (const task of db.prepare(`SELECT * FROM tasks WHERE root_id=? AND ${WAITING}`).all(root.id) as TaskRow[]) setState(gov, task, "ready");
}

/** Stops every goal of the workspace whose checkpoint nobody answered in time, saying why. Returns how many. */
export function expireCheckpoints(gov: Gov, workspaceId: string, stop: (root: TaskRow) => void): number {
  const now = gov.clock.nowMs();
  let n = 0;
  for (const task of gov.db.prepare(`SELECT * FROM tasks WHERE workspace_id=? AND ${WAITING}`).all(workspaceId) as TaskRow[]) {
    const need = needOf(task);
    if (need?.kind !== "checkpoint" || need.until > now) continue;
    const root = taskOf(gov.db, task.root_id);
    if (root.state === "stopped") continue;
    const reason = `Stopped: nobody answered the checkpoint within ${manifestOf(gov, root.snapshot_digest).limits.checkpoint_timeout}.`;
    gov.db.prepare("INSERT INTO notes(workspace_id, root_id, author, attempt_id, text, created_at_ms) VALUES (?,?,?,?,?,?)").run(root.workspace_id, root.id, "Brain", null, reason, now);
    append(gov.db, { type: "task.checkpoint_expired", workspaceId, subject: `task:${root.id}`, payload: { title: root.title, reason }, actor: SYSTEM });
    stop(root);
    setState(gov, taskOf(gov.db, root.id), "stopped", { result: reason });
    n += 1;
  }
  return n;
}
