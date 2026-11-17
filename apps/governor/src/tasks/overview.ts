import { BrainError, type Approval, type Overview, type OverviewDay, type OverviewHealth, type OverviewNeed, type OverviewRun, type OverviewWorkspace } from "@brain/contracts";
import { visibleWorkspaces } from "../access";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { auditProblem, modelHealth } from "../health/health";
import { listRunners } from "../attempts/runners";
import { approvalsWhere } from "../trust/approvals";
import { COST, capOf, spentToday } from "../trust/usage";
import { activeManifest } from "../workspace/store";
import { summaries } from "./handlers";
import { utcDay } from "./store";

/** The Overview (docs/architecture.md section 10): what every workspace the caller belongs to is doing, in one answer. */
const DAYS = 14;
const DAY_MS = 86_400_000;
const NEEDS_LIMIT = 50;
const RUNNING_LIMIT = 30;
/** How long the Overview waits for a model's answer; a model that has not answered by then is left out of the count (its probe goes on and is kept). */
const MODEL_WAIT_MS = 1500;

const marks = (values: readonly unknown[]): string => values.map(() => "?").join(",");
const rows = <T>(db: Db, sql: string, ...values: unknown[]): T[] => db.prepare(sql).all(...values) as T[];

/** The last `DAYS` UTC days up to the day of `now`, oldest first. */
const windowOf = (now: number): string[] => Array.from({ length: DAYS }, (_, index) => utcDay(now - (DAYS - 1 - index) * DAY_MS));

async function healthOf(gov: Gov, now: number): Promise<OverviewHealth> {
  const runners = listRunners(gov);
  const answers = (gov.db.prepare("SELECT id FROM workspaces WHERE status='active'").all() as Array<{ id: string }>).flatMap(({ id }) => activeManifest(gov, id).models.map((model) => modelHealth(gov, id, model, now).catch(() => ({ reachable: false }))));
  let waiting = true;
  const settled: Array<{ reachable: boolean }> = [];
  await Promise.race([
    Promise.all(answers.map((answer) => answer.then((result) => { if (waiting) settled.push(result); }))),
    new Promise<void>((done) => setTimeout(done, MODEL_WAIT_MS).unref()),
  ]);
  waiting = false;
  return {
    runnersOnline: runners.filter((runner) => runner.online).length, runnersTotal: runners.length,
    modelsReachable: settled.filter((answer) => answer.reachable).length, modelsTotal: settled.length, auditProblem: auditProblem(gov, now),
  };
}

export function registerOverview({ gov }: Governor): void {
  gov.registry.query("overview", async (ctx): Promise<Overview> => {
    const { user, db } = ctx;
    if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const now = ctx.now();
    const health = user.instanceAdmin ? await healthOf(gov, now) : null;
    const mine = visibleWorkspaces(gov, user.id).filter((workspace) => workspace.status === "active").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (mine.length === 0) return { workspaces: [], needsYou: [], running: [], health };
    const ids = mine.map((workspace) => workspace.id);
    const inMine = `IN (${marks(ids)})`;
    const days = windowOf(now);
    const today = days[DAYS - 1] as string;
    const since = Date.parse(`${days[0]}T00:00:00Z`);
    const byWorkspace = <T extends { workspace_id: string }>(list: readonly T[]): Map<string, T[]> => {
      const out = new Map<string, T[]>();
      for (const row of list) out.set(row.workspace_id, [...(out.get(row.workspace_id) ?? []), row]);
      return out;
    };

    const waiting = new Map(rows<{ workspace_id: string; n: number }>(db, `SELECT workspace_id, COUNT(*) AS n FROM tasks WHERE workspace_id ${inMine} AND state='needs_you' GROUP BY workspace_id`, ...ids).map((row) => [row.workspace_id, row.n]));
    // The goals Today lists as running: started, and no task under them waits for a person.
    const running = new Map(rows<{ workspace_id: string; n: number }>(db, `SELECT t.workspace_id, COUNT(*) AS n FROM tasks t WHERE t.workspace_id ${inMine} AND t.parent_id IS NULL AND t.state IN ('waiting','ready','running')
      AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.root_id = t.id AND x.state='needs_you') GROUP BY t.workspace_id`, ...ids).map((row) => [row.workspace_id, row.n]));
    const finished = byWorkspace(rows<{ workspace_id: string; day: string; state: string; n: number }>(db, `SELECT workspace_id, date(finished_at_ms / 1000, 'unixepoch') AS day, state, COUNT(*) AS n FROM tasks
      WHERE workspace_id ${inMine} AND parent_id IS NULL AND state IN ('done','failed') AND finished_at_ms >= ? GROUP BY workspace_id, day, state`, ...ids, since));
    const spent = byWorkspace(rows<{ workspace_id: string; day: string; micro: number }>(db, `SELECT u.workspace_id, u.day, COALESCE(SUM(${COST}), 0) AS micro FROM usage u WHERE u.workspace_id ${inMine} AND u.day >= ? GROUP BY u.workspace_id, u.day`, ...ids, days[0]));
    const last = new Map(ids.map((id) => [id, (db.prepare("SELECT MAX(updated_at_ms) AS at FROM tasks WHERE workspace_id=?").get(id) as { at: number | null }).at]));

    const workspaces = mine.map((workspace): OverviewWorkspace => {
      const done = new Map<string, number>();
      let failedToday = 0;
      for (const row of finished.get(workspace.id) ?? []) {
        if (row.state === "done") done.set(row.day, row.n);
        else if (row.day === today) failedToday = row.n;
      }
      const cost = new Map((spent.get(workspace.id) ?? []).map((row) => [row.day, row.micro]));
      const series = days.map((day): OverviewDay => ({ day, done: done.get(day) ?? 0, microUsd: cost.get(day) ?? 0 }));
      const manifest = activeManifest(gov, workspace.id);
      return {
        id: workspace.id, slug: workspace.slug, name: workspace.name, role: workspace.role, visibility: workspace.visibility, viaPublic: workspace.viaPublic, projects: manifest.projects.map((project) => project.name), needsYou: workspace.viaPublic ? 0 : (waiting.get(workspace.id) ?? 0), running: running.get(workspace.id) ?? 0,
        doneToday: done.get(today) ?? 0, failedToday, spend: { todayMicroUsd: spentToday(gov, workspace.id), capMicroUsd: capOf(manifest) }, lastActivityAt: last.get(workspace.id) ?? null, days: series,
      };
    });
    const named = new Map(mine.map((workspace) => [workspace.id, workspace]));
    const place = (task: { workspaceId: string }): { workspaceName: string; workspaceSlug: string } => ({ workspaceName: named.get(task.workspaceId)?.name ?? "", workspaceSlug: named.get(task.workspaceId)?.slug ?? "" });

    // A call waits for an approval only while its task is `needs_you`, so the waiting tasks are the whole list.
    const actionable = ids.filter((id) => !named.get(id)?.viaPublic);
    const waitingTasks = summaries(db, `t.workspace_id IN (${marks(actionable)}) AND t.state='needs_you' ORDER BY t.updated_at_ms DESC, t.rowid DESC LIMIT ?`, ...actionable, NEEDS_LIMIT);
    const approvals = new Map<string, Approval>(approvalsWhere(db, `a.state='pending' AND a.task_id IN (${marks(waitingTasks)})`, ...waitingTasks.map((task) => task.id)).map((approval) => [approval.id, approval]));
    const needsYou = waitingTasks.map((task): OverviewNeed => ({ ...task, ...place(task), approval: task.needs?.kind === "approval" ? (approvals.get(task.needs.approvalId) ?? null) : null }));

    const attempts = rows<{ id: string; kind: OverviewRun["kind"]; agent: string; workspace_id: string; task_id: string; started_at_ms: number | null; root_id: string; title: string; step_id: string | null; goal_title: string; micro: number }>(db,
      `SELECT a.id, a.kind, a.agent, a.workspace_id, a.task_id, a.started_at_ms, t.root_id, t.title, t.step_id, r.title AS goal_title, COALESCE(${COST}, 0) AS micro
       FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN tasks r ON r.id = t.root_id LEFT JOIN usage u ON u.attempt_id = a.id
       WHERE a.workspace_id ${inMine} AND a.state='running' ORDER BY a.started_at_ms DESC LIMIT ?`, ...ids, RUNNING_LIMIT);
    const runningNow = attempts.map((attempt): OverviewRun => ({
      attemptId: attempt.id, kind: attempt.kind, agent: attempt.agent, workspaceId: attempt.workspace_id, ...place({ workspaceId: attempt.workspace_id }), rootId: attempt.root_id, taskId: attempt.task_id,
      goalTitle: attempt.goal_title, title: attempt.title, stepId: attempt.step_id, startedAt: attempt.started_at_ms, microUsd: attempt.micro,
    }));
    return { workspaces, needsYou, running: runningNow, health };
  });
}
