import { pathProblem, type AttemptFailure, type JsonValue } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { healedBy } from "../tasks/heal";
import type { AttemptRow, TaskRow } from "../tasks/store";
import { readSecret } from "../trust/secrets";
import { platformWorkspace } from "../workspace/platform";
import { manifestOf } from "../workspace/store";
import { currentText } from "./fix";
import { driftOf } from "./drift";
import { repeatsOf } from "./repeats";
import { ToolRefusal } from "./schema";

/**
 * The platform workspace's read-only tools (docs/architecture.md section 7; inputs and outputs in packs/README.md). They run inside the transaction that
 * records the call, so each cross-workspace read is in the audit chain with it. Nothing here writes, and a secret's value never leaves.
 */
type Input = { readonly [name: string]: JsonValue };
interface Target { readonly id: string; readonly slug: string }
const DAY_MS = 86_400_000;
const FILE_MAX = 20_000;
const cut = (value: string | null, max: number): string => (value === null ? "" : value.length <= max ? value : `${value.slice(0, max)} [cut: ${value.length - max} more characters]`);
const dollars = (micro: number): number => Math.round(micro) / 1_000_000;
const days = (input: Input): number => Math.min(90, Math.max(1, (input["days"] as number | undefined) ?? 30));

/** Hides the values of a workspace's secrets in a text a tool call echoed back. */
function hider(gov: Gov, workspaceId: string): (text: string) => string {
  const values = (gov.db.prepare("SELECT name FROM secrets WHERE workspace_id=?").all(workspaceId) as Array<{ name: string }>)
    .map((row) => readSecret(gov, workspaceId, row.name)).filter((value): value is string => value !== undefined && value.length >= 4);
  return (text) => values.reduce((shown, value) => shown.split(value).join("[secret]"), text);
}

export function runPlatform(gov: Gov, attempt: AttemptRow, task: TaskRow, tool: string, input: Input): JsonValue {
  const { db } = gov;
  const platform = platformWorkspace(gov);
  if (platform?.id !== task.workspace_id) throw new ToolRefusal(`${tool} is only for the tasks of the platform workspace`);
  const workspaceNamed = (slug: string): Target => {
    const row = db.prepare("SELECT id, slug FROM workspaces WHERE slug=?").get(slug) as Target | undefined;
    if (!row) throw new ToolRefusal(`There is no workspace "${slug}"; platform.workspaces lists them`);
    return row;
  };
  /** One audit event per other workspace read, written with the call. */
  const audit = (targets: readonly Target[], what: string): void => {
    for (const target of new Map(targets.map((one) => [one.id, one])).values()) {
      if (target.id === platform.id) continue;
      append(db, { type: "platform.read", workspaceId: target.id, subject: `workspace:${target.id}`, payload: { source: platform.slug, target: target.slug, tool, taskId: task.id, what }, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } });
    }
  };
  const since = gov.clock.nowMs() - days(input) * DAY_MS;
  const cost = (where: string, value: string): number => (db.prepare(`SELECT COALESCE(SUM(COALESCE(settled_micro_usd, metered_micro_usd)), 0) AS micro FROM usage WHERE ${where}=? AND created_at_ms>=?`).get(value, since) as { micro: number }).micro;

  if (tool === "platform.workspaces") {
    const rows = db.prepare("SELECT id, slug, name, active_snapshot AS snapshot FROM workspaces ORDER BY slug").all() as Array<Target & { name: string; snapshot: string }>;
    audit(rows, "list");
    return {
      workspaces: rows.map((row) => {
        const manifest = manifestOf(gov, row.snapshot as never);
        const counts = Object.fromEntries((db.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE workspace_id=? AND parent_id IS NULL AND created_at_ms>=? GROUP BY state").all(row.id, since) as Array<{ state: string; n: number }>).map((count) => [count.state, count.n]));
        return {
          slug: row.slug, name: row.name, packs: manifest.packs, platform: manifest.platform === true, agents: Object.keys(manifest.agents).length, tools: Object.keys(manifest.tools).length, plays: Object.keys(manifest.plays).length,
          tasks: { done: counts["done"] ?? 0, failed: counts["failed"] ?? 0, needs_you: counts["needs_you"] ?? 0, running: counts["running"] ?? 0 }, spend_usd: dollars(cost("workspace_id", row.id)),
        };
      }),
    };
  }

  if (tool === "platform.tasks") {
    const only = input["workspace"] === undefined ? undefined : workspaceNamed(input["workspace"] as string);
    const query = ((input["query"] as string | undefined) ?? "").toLowerCase();
    const rows = db.prepare(`SELECT t.id, t.workspace_id AS wid, w.slug AS workspace, t.title, t.agent, t.state, t.goal, t.result, t.created_by, t.created_at_ms AS at FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.agent IS NOT NULL AND t.created_at_ms>=? AND (? IS NULL OR t.workspace_id=?) AND (? IS NULL OR t.state=?) AND (? IS NULL OR t.agent=?) AND (?='' OR instr(lower(t.title || ' ' || t.goal), ?)>0)
      ORDER BY t.created_at_ms DESC, t.rowid DESC LIMIT ?`).all(since, only?.id ?? null, only?.id ?? null, (input["state"] as string | undefined) ?? null, (input["state"] as string | undefined) ?? null, (input["agent"] as string | undefined) ?? null, (input["agent"] as string | undefined) ?? null, query, query, Math.min(50, Math.max(1, (input["limit"] as number | undefined) ?? 20))) as Array<{ id: string; wid: string; workspace: string; title: string; agent: string; state: string; goal: string; result: string | null; created_by: string; at: number }>;
    audit(rows.map((row) => ({ id: row.wid, slug: row.workspace })), `tasks ${rows.map((row) => row.id).join(" ")}`);
    const hide = new Map<string, (text: string) => string>();
    const hidden = (wid: string, text: string): string => (hide.get(wid) ?? hide.set(wid, hider(gov, wid)).get(wid) as (text: string) => string)(text);
    return {
      tasks: rows.map((row) => ({
        id: row.id, workspace: row.workspace, title: row.title, agent: row.agent, state: row.state, goal: hidden(row.wid, cut(row.goal, 500)), result: hidden(row.wid, cut(row.result, 500)), created: new Date(row.at).toISOString(),
        cost_usd: dollars((db.prepare("SELECT COALESCE(SUM(COALESCE(settled_micro_usd, metered_micro_usd)), 0) AS micro FROM usage WHERE task_id=?").get(row.id) as { micro: number }).micro), ...(healedBy(row) ? { heals: healedBy(row) as string } : {}),
      })),
    };
  }

  if (tool === "platform.task") {
    const target = workspaceNamed(input["workspace"] as string);
    const row = db.prepare("SELECT * FROM tasks WHERE id=? AND workspace_id=?").get(input["id"] as string, target.id) as TaskRow | undefined;
    if (!row) throw new ToolRefusal(`${target.slug} has no task ${input["id"] as string}`);
    audit([target], `task ${row.id}`);
    const hide = hider(gov, target.id);
    const tree = "WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)";
    const ids = (db.prepare(`${tree} SELECT id FROM tree`).all(row.id) as Array<{ id: string }>).map((one) => one.id);
    const marks = ids.map(() => "?").join(",");
    const usage = db.prepare(`SELECT COALESCE(SUM(COALESCE(settled_micro_usd, metered_micro_usd)), 0) AS micro, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM usage WHERE task_id IN (${marks})`).get(...ids) as { micro: number; tokens: number };
    return {
      id: row.id, workspace: target.slug, title: row.title, agent: row.agent, state: row.state, play: row.play, step: row.step_id, goal: hide(cut(row.goal, 4000)), result: hide(cut(row.result, 4000)), ...(healedBy(row) ? { heals: healedBy(row) as string } : {}),
      tasks: (db.prepare(`SELECT id, title, agent, state FROM tasks WHERE id IN (${marks}) AND id != ? ORDER BY rowid LIMIT 40`).all(...ids, row.id) as Array<{ id: string; title: string; agent: string | null; state: string }>).map((one) => ({ ...one })),
      attempts: (db.prepare(`SELECT id, task_id, kind, agent, state, round, failure_json, result FROM attempts WHERE task_id IN (${marks}) ORDER BY rowid DESC LIMIT 20`).all(...ids) as Array<{ id: string; task_id: string; kind: string; agent: string; state: string; round: number; failure_json: string | null; result: string | null }>).reverse().map((one) => {
        const failure = one.failure_json ? (JSON.parse(one.failure_json) as AttemptFailure) : undefined;
        return { id: one.id, task: one.task_id, kind: one.kind, agent: one.agent, state: one.state, round: one.round, ...(failure ? { failure: `${failure.reason}${failure.infrastructure ? " (infrastructure)" : ""}: ${hide(cut(failure.detail, 800))}` } : {}), said: hide(cut(one.result, 800)) };
      }),
      toolCalls: (db.prepare(`SELECT task_id, tool, effect, outcome, input_json, output_json FROM tool_calls WHERE task_id IN (${marks}) ORDER BY rowid LIMIT 40`).all(...ids) as Array<{ task_id: string; tool: string; effect: string; outcome: string; input_json: string; output_json: string | null }>)
        .map((one) => ({ task: one.task_id, tool: one.tool, effect: one.effect, outcome: one.outcome, input: hide(cut(one.input_json, 1500)), output: hide(cut(one.output_json, 2000)) })),
      checks: (db.prepare(`SELECT round, by_id, pass, findings FROM checks WHERE task_id IN (${marks}) ORDER BY id DESC LIMIT 10`).all(...ids) as Array<{ round: number; by_id: string; pass: number; findings: string }>).map((one) => ({ round: one.round, by: one.by_id, pass: one.pass === 1, findings: hide(cut(one.findings, 1000)) })),
      cost_usd: dollars(usage.micro), tokens: usage.tokens,
    };
  }

  if (tool === "platform.file") {
    const target = workspaceNamed(input["workspace"] as string);
    const path = input["path"] as string;
    const problem = pathProblem(path);
    if (problem !== undefined) throw new ToolRefusal(`${path} is not a file of a workspace: ${problem}`);
    const content = currentText(gov, target.slug, manifestOf(gov, (db.prepare("SELECT active_snapshot AS s FROM workspaces WHERE id=?").get(target.id) as { s: string }).s as never), path);
    if (content === undefined) throw new ToolRefusal(`${target.slug} has no file ${path}`);
    if (content.includes("\0")) throw new ToolRefusal(`${path} is not a text file`);
    audit([target], `file ${path}`);
    return { path, content: hider(gov, target.id)(cut(content, FILE_MAX)), truncated: content.length > FILE_MAX };
  }

  if (tool === "platform.tool-drift") {
    const drift = driftOf(gov);
    audit(drift.workspaces.map(workspaceNamed), "tool-drift");
    return { drift: drift.entries };
  }

  // platform.repeats
  const found = repeatsOf(gov, days(input)) as { candidates: Array<{ tasks: Array<{ workspace: string }> }> };
  audit([...new Set(found.candidates.flatMap((candidate) => candidate.tasks.map((one) => one.workspace)))].map(workspaceNamed), "repeats");
  return found as unknown as JsonValue;
}
