import type { JsonValue } from "@brain/contracts";
import type { Gov } from "../dispatch";

/**
 * `platform.repeats` (docs/architecture.md section 7): work that was done the same way, found without a model. Pure grouping over plain rows,
 * so a test can feed it jobs; `repeatsOf` reads the rows.
 */
export const MIN_REPEATS = 4;
const SIMILAR = 0.6;
const DAY_MS = 86_400_000;
/** The calls that are bookkeeping of a task, not what it did. */
const NOISE = new Set(["task.note", "task.ask", "task.create", "memory.search", "memory.propose"]);
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "are", "was", "has", "have", "you", "your", "all", "any", "into", "its", "not", "but", "les", "des", "pour", "avec", "dans", "une", "que", "qui", "est", "sur", "par", "aux", "ces", "ses", "son", "vos", "nos"]);

export interface Job { readonly id: string; readonly workspace: string; readonly agent: string; readonly tools: readonly string[]; readonly goal: string; readonly at: number }

/** A goal as its set of words: lower case, no URL, no word with a digit, only letters, three or more of them, no stop word. */
export function wordsOf(goal: string): ReadonlySet<string> {
  const text = goal.toLowerCase().replace(/https?:\/\/\S+/gu, " ");
  return new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => /^\p{L}{3,}$/u.test(word) && !STOP.has(word)));
}
const similar = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  const shared = [...a].filter((word) => b.has(word)).length;
  const all = a.size + b.size - shared;
  return all === 0 ? true : shared / all >= SIMILAR;
};

interface Group { readonly words: ReadonlySet<string>; readonly jobs: Job[] }

/** Groups of `min` or more jobs of the same agent with the same tools and similar goals, the biggest first. */
export function groupRepeats(jobs: readonly Job[], min = MIN_REPEATS): JsonValue[] {
  const byKind = new Map<string, Group[]>();
  for (const job of [...jobs].sort((a, b) => a.at - b.at)) {
    const kind = `${job.agent}\n${job.tools.join(">")}`;
    const groups = byKind.get(kind) ?? [];
    const words = wordsOf(job.goal);
    const group = groups.find((candidate) => similar(candidate.words, words));
    if (group) group.jobs.push(job);
    else groups.push({ words, jobs: [job] });
    byKind.set(kind, groups);
  }
  return [...byKind.values()].flat().filter((group) => group.jobs.length >= min).sort((a, b) => b.jobs.length - a.jobs.length || (a.jobs[0] as Job).agent.localeCompare((b.jobs[0] as Job).agent)).slice(0, 20).map((group) => {
    const first = group.jobs[0] as Job;
    const counts = new Map<string, number>();
    for (const job of group.jobs) counts.set(job.workspace, (counts.get(job.workspace) ?? 0) + 1);
    return {
      agent: first.agent, tools: [...first.tools], count: group.jobs.length,
      workspaces: [...counts].map(([slug, count]) => ({ slug, count })),
      goals: group.jobs.slice(0, 3).map((job) => job.goal.slice(0, 300)),
      tasks: group.jobs.slice(0, 8).map((job) => ({ workspace: job.workspace, id: job.id })),
      first: new Date(first.at).toISOString(), last: new Date((group.jobs.at(-1) as Job).at).toISOString(),
    };
  });
}

/** The done jobs of every workspace in the last `days` days, with the tools each called. Heal tasks and the platform's own agents are not work to repeat. */
export function repeatsOf(gov: Gov, days: number): JsonValue {
  const since = gov.clock.nowMs() - days * DAY_MS;
  const eligible = `FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.state='done' AND t.agent IS NOT NULL AND t.agent NOT IN ('workspace-healer','capitalizer') AND t.created_at_ms >= ?
    AND (SELECT created_by FROM tasks r WHERE r.id = t.root_id) NOT LIKE 'heal:%' AND EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = t.id AND a.kind = 'work')`;
  const tasks = gov.db.prepare(`SELECT t.id, w.slug AS workspace, t.agent, t.goal, t.created_at_ms AS at ${eligible} ORDER BY t.created_at_ms, t.rowid`).all(since) as Array<Omit<Job, "tools">>;
  const calls = new Map<string, string[]>();
  for (const row of gov.db.prepare(`SELECT c.task_id AS id, c.tool FROM tool_calls c WHERE c.outcome='succeeded' AND c.task_id IN (SELECT t.id ${eligible}) ORDER BY c.rowid`).all(since) as Array<{ id: string; tool: string }>) {
    if (!NOISE.has(row.tool)) calls.set(row.id, [...(calls.get(row.id) ?? []), row.tool]);
  }
  return { days, min: MIN_REPEATS, candidates: groupRepeats(tasks.map((task) => ({ ...task, tools: calls.get(task.id) ?? [] }))) };
}
