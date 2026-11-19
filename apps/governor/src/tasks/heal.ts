import type { Actor, AttemptFailure, SnapshotManifest } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { currentText } from "../tools/fix";
import { activeManifest, getWorkspace } from "../workspace/store";
import { insertTask, taskOf, utcDay, type TaskRow } from "./store";

/**
 * Healing (docs/model.md, "When a task fails"): a task that failed all its attempts gets one goal, run by `workspace-healer`, that finds why and proposes a fix.
 * The goal's `created_by` is `heal:<failed task id>`, which is all that links the two.
 */
export const HEAL = "heal:";
const HEALER = "workspace-healer";
/** The id of the task a heal task heals; undefined for any other task. */
export const healedBy = (task: Pick<TaskRow, "created_by">): string | undefined => (task.created_by.startsWith(HEAL) ? task.created_by.slice(HEAL.length) : undefined);

const cut = (value: string | null, max: number): string => (value === null ? "" : value.length <= max ? value : `${value.slice(0, max)} [cut: ${value.length - max} more characters]`);
const FILE_MAX = 6000;
const TOTAL_MAX = 40_000;

/** What is written on the failed task's goal when no heal task is started, so a person knows why. */
function note(gov: Gov, failed: TaskRow, text: string): void {
  // The same words once: a task that fails again for the same reason does not write them again.
  if (gov.db.prepare("SELECT 1 FROM notes WHERE root_id=? AND author='Brain' AND text=?").get(failed.root_id, text)) return;
  gov.db.prepare("INSERT INTO notes(workspace_id, root_id, author, attempt_id, text, created_at_ms) VALUES (?,?,?,?,?,?)").run(failed.workspace_id, failed.root_id, "Brain", null, text, gov.clock.nowMs());
  append(gov.db, { type: "task.noted", workspaceId: failed.workspace_id, subject: `task:${failed.id}`, payload: { rootId: failed.root_id, author: "Brain" }, actor: SYSTEM });
}

interface Row { readonly [column: string]: string | number | null }

/** The evidence of a failure: the chain, every attempt, every call, every check, and the files of the agents, tools and Play involved. */
function evidenceOf(gov: Gov, failed: TaskRow, manifest: SnapshotManifest): string {
  const { db } = gov;
  const tree = "WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)";
  const root = taskOf(db, failed.root_id);
  const chain = (db.prepare(`${tree} SELECT t.id, t.title, t.agent, t.state, t.result FROM tasks t WHERE t.id IN (SELECT id FROM tree) ORDER BY t.rowid LIMIT 40`).all(root.id) as Row[])
    .map((row) => `- ${row["id"] as string} "${row["title"] as string}" agent ${(row["agent"] as string | null) ?? "none"}, ${row["state"] as string}${row["id"] === failed.id ? " (THE FAILED TASK)" : ""}${row["result"] ? `: ${cut(row["result"] as string, 300)}` : ""}`);
  const below = (db.prepare(`${tree} SELECT id FROM tree`).all(failed.id) as Array<{ id: string }>).map((row) => row.id);
  const marks = below.map(() => "?").join(",");
  const attempts = (db.prepare(`SELECT id, task_id, kind, agent, state, round, failure_json, result FROM attempts WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 12`).all(...below) as Row[]).reverse();
  const calls = (db.prepare(`SELECT tool, effect, outcome, input_json, output_json FROM tool_calls WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 20`).all(...below) as Row[]).reverse();
  const checks = db.prepare(`SELECT round, by_id, pass, findings FROM checks WHERE task_id IN (${marks}) ORDER BY id DESC LIMIT 6`).all(...below) as Row[];
  const lines = [
    `## The failed task\nid ${failed.id}, "${failed.title}", agent ${failed.agent ?? "none"}, round ${failed.round}, Play ${root.play ?? "none"}${failed.step_id ? `, step ${failed.step_id}` : ""}\nGoal:\n${cut(failed.goal, 4000)}\nHow it ended: ${cut(failed.result, 1500)}`,
    `## The goal's tasks\n${chain.join("\n")}`,
    `## Attempts, oldest first\n${attempts.map((row) => {
      const failure = row["failure_json"] ? (JSON.parse(row["failure_json"] as string) as AttemptFailure) : undefined;
      return `- ${row["id"] as string} ${row["kind"] as string} by ${row["agent"] as string} on task ${row["task_id"] as string}, ${row["state"] as string}${failure ? `, failure ${failure.reason}${failure.infrastructure ? " (infrastructure)" : ""}: ${cut(failure.detail, 1500)}` : ""}${row["result"] ? `\n  said: ${cut(row["result"] as string, 800)}` : ""}`;
    }).join("\n") || "none"}`,
    `## Tool calls, oldest first\n${calls.map((row) => `- ${row["tool"] as string} (${row["effect"] as string}) ${row["outcome"] as string}\n  input: ${cut(row["input_json"] as string, 800)}\n  output: ${cut(row["output_json"] as string | null, 1500)}`).join("\n") || "none"}`,
    `## Checks\n${checks.map((row) => `- round ${row["round"] as number} by ${row["by_id"] as string}: ${row["pass"] === 1 ? "passed" : "failed"}: ${cut(row["findings"] as string, 1000)}`).join("\n") || "none"}`,
  ];
  // The files the failure may come from: the agents that attempted, their tools that were called, the Play, and brain.toml.
  const agents = [...new Set([...(failed.agent ? [failed.agent] : []), ...attempts.map((row) => row["agent"] as string)])].filter((name) => manifest.agents[name]);
  const tools = [...new Set(calls.map((row) => row["tool"] as string))].filter((name) => manifest.tools[name]);
  const paths = [
    "brain.toml", ...(root.play && manifest.plays[root.play] ? [`plays/${root.play}.toml`] : []),
    ...agents.flatMap((name) => [`agents/${name}/agent.toml`, `agents/${name}/prompt.md`]),
    ...tools.flatMap((name) => [`tools/${name}/tool.toml`, ...(manifest.tools[name]?.files ?? []).map((file) => `tools/${name}/${file.path}`)]),
  ];
  const slug = getWorkspace(db, failed.workspace_id).slug;
  let budget = TOTAL_MAX;
  const files: string[] = [];
  for (const path of [...new Set(paths)]) {
    const content = currentText(gov, slug, manifest, path);
    if (content === undefined || budget <= 0) continue;
    const shown = cut(content, Math.min(FILE_MAX, budget));
    budget -= shown.length;
    files.push(`### ${path}${shown !== content ? " (CUT: do not rewrite this file; ask a person instead)" : ""}\n\`\`\`\n${shown}\n\`\`\``);
  }
  return `${lines.join("\n\n")}\n\n## The workspace files involved, as they are now\n${files.join("\n\n")}`;
}

/**
 * Called in the transaction that failed a task. Starts its heal task, unless healing is off or the workspace has no healer, the task is itself a heal task or was
 * healed, the day's heal tasks are used up, or only infrastructure failed it (the failed task's goal says so).
 */
export function healFailed(gov: Gov, failed: TaskRow): void {
  const { db } = gov;
  if (healedBy(taskOf(db, failed.root_id)) !== undefined || db.prepare("SELECT 1 FROM tasks WHERE created_by=?").get(`${HEAL}${failed.id}`)) return;
  const workspace = getWorkspace(db, failed.workspace_id);
  const active = activeManifest(gov, workspace.id);
  if (active.healing.mode === "off" || !active.agents[HEALER]) return;
  const failures = (db.prepare("SELECT failure_json FROM attempts WHERE task_id=? AND state='failed'").all(failed.id) as Array<{ failure_json: string | null }>).map((row) => (row.failure_json ? (JSON.parse(row.failure_json) as AttemptFailure) : undefined));
  if (failures.length > 0 && failures.every((failure) => failure?.infrastructure === true)) return note(gov, failed, `"${failed.title}" failed only for infrastructure reasons (${failures.at(-1)?.reason ?? "runner"}: ${cut(failures.at(-1)?.detail ?? "", 300)}); no change of the workspace would help, so it was not analysed. Try it again once the cause is gone.`);
  const today = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND created_by LIKE 'heal:%' AND created_at_ms>=?").get(workspace.id, Date.parse(utcDay(gov.clock.nowMs()))) as { n: number };
  if (active.healing.per_day > 0 && today.n >= active.healing.per_day) return note(gov, failed, `"${failed.title}" was not analysed: the workspace already started ${active.healing.per_day} heal tasks today (healing.per_day in brain.toml).`);
  insertTask(gov, SYSTEM, {
    workspaceId: workspace.id, parent: null, snapshotDigest: workspace.snapshotDigest, title: `Heal: ${failed.title}`.slice(0, 200), agent: HEALER, state: "ready", createdBy: `${HEAL}${failed.id}`,
    goal: `The task "${failed.title}" (id ${failed.id}) failed all its attempts. Find the cause of the repeated failure and either propose a fix with workspace.fix (task: "${failed.id}") or ask a person with task.ask. A task that is retried or healed runs on the workspace snapshot recorded when the task started, unless workspace.fix moved it; the files below are the workspace as it is now, so an older snapshot may have differed (for example a task started before the workspace had a model).\n\n${evidenceOf(gov, failed, active)}`,
  });
}

/**
 * A heal task that waits for a person (a question, an approval) ends when the task it heals is `done`, whatever made it so (a retry, a person, a fix that came
 * from elsewhere): there is nothing left to find. One that is working finishes by itself. Returns how many it stopped. `stopTask` is the orchestrator's, which ends a goal and everything under it.
 */
export function closeHealed(gov: Gov, workspaceId: string, stopTask: (gov: Gov, task: TaskRow, actor: Actor) => number): number {
  const { db } = gov;
  const heals = db.prepare(`SELECT h.* FROM tasks h WHERE h.workspace_id=? AND h.parent_id IS NULL AND h.created_by LIKE '${HEAL}%' AND h.state = 'needs_you'
    AND EXISTS (SELECT 1 FROM tasks f WHERE f.id = substr(h.created_by, ${HEAL.length + 1}) AND f.state='done')`).all(workspaceId) as TaskRow[];
  for (const heal of heals) {
    stopTask(gov, heal, SYSTEM);
    append(db, { type: "task.heal-closed", workspaceId, subject: `task:${heal.id}`, payload: { healed: healedBy(heal) ?? null }, actor: SYSTEM });
  }
  return heals.length;
}
