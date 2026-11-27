import { MAX_ATTEMPTS, parseRef, RETRY_DELAYS_MS, parseWhen, renderTemplate, type AttemptFailure, type JsonValue, type Ref, type TaskNeed, type TaskState } from "@brain/contracts";

/**
 * The decisions of orchestration (docs/architecture.md section 5) as pure functions over plain data: what a waiting task becomes, what
 * follows a work attempt, a check, a judgement and a person's answer, when a parent is done, and when a failed attempt is tried again.
 * `orchestrator.ts` reads the facts from the database and writes what these functions decide.
 */

// --- results and templates ---

/** The JSON object an agent's whole final answer is, a code fence around it removed. Undefined when the answer is not one. */
export function resultObject(text: string): { readonly [key: string]: JsonValue } | undefined {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  try {
    const value = JSON.parse(fenced?.[1] ?? trimmed) as JsonValue;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { readonly [key: string]: JsonValue }) : undefined;
  } catch {
    return undefined;
  }
}

export const SKIPPED = "skipped";
interface StepResult { readonly result: string; readonly output?: JsonValue | null }
/** What a step's templates can read: the Play's inputs, the results of earlier steps by step id, and the item of a `for_each` copy. */
export interface Scope {
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly steps: Readonly<Record<string, StepResult | undefined>>;
  readonly item?: JsonValue;
}

function dig(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = Array.isArray(at) ? at[Number(key)] : (at as { readonly [key: string]: JsonValue })[key];
  }
  return at;
}

/** The value a reference names, or undefined when it does not resolve (a missing field, a result that is not JSON, a skipped step). */
function resolveRef(ref: Ref, scope: Scope): JsonValue | undefined {
  if (ref.kind === "input") return dig(scope.inputs[ref.name], ref.path);
  if (ref.kind === "item") return dig(scope.item, ref.path);
  const step = scope.steps[ref.step];
  if (!step || step.result === SKIPPED) return undefined;
  if (ref.path.length === 0) return step.result;
  return dig(step.output !== undefined && step.output !== null ? step.output : resultObject(step.result), ref.path);
}

/** A step's goal with its placeholders filled in. With `keepSteps`, a reference to an earlier result stays as written, for a task that still waits. */
export function renderGoal(template: string, scope: Scope, keepSteps = false): string {
  return renderTemplate(template, (ref) => (keepSteps && ref.kind === "step" ? `{{steps.${[ref.step, "result", ...ref.path].join(".")}}}` : resolveRef(ref, scope)));
}

/** Whether a step's `when` holds. A left side that does not resolve makes `==` false and `!=` true. */
export function whenHolds(expression: string, scope: Scope): boolean {
  const when = parseWhen(expression);
  if (!when) return false;
  const value = resolveRef(when.ref, scope);
  const equal = value !== undefined && value === when.value;
  return when.op === "==" ? equal : !equal;
}

/** The items a `for_each` names: a list in an earlier result, or nothing. */
export function forEachItems(expression: string, scope: Scope): JsonValue[] {
  const ref = parseRef(expression);
  const value = ref ? resolveRef(ref, scope) : undefined;
  return Array.isArray(value) ? [...value] : [];
}

// --- a waiting task whose prerequisites are done ---

export type Promotion = { readonly to: "ready" } | { readonly to: "skipped" } | { readonly to: "copies"; readonly items: JsonValue[] } | { readonly to: "running" };
export function promote(task: { readonly agent: string | null; readonly when: string | null; readonly forEach: string | null }, scope: Scope): Promotion {
  if (task.when !== null && !whenHolds(task.when, scope)) return { to: "skipped" };
  if (task.forEach !== null) {
    const items = forEachItems(task.forEach, scope);
    return items.length === 0 ? { to: "skipped" } : { to: "copies", items };
  }
  return task.agent === null ? { to: "running" } : { to: "ready" };
}

/** The first pattern (`*` for any run of characters) that no memory entry name matches; undefined when every one does. */
export function missingMemory(requires: readonly string[], names: readonly string[]): string | undefined {
  return requires.find((pattern) => {
    const match = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
    return !names.some((name) => match.test(name));
  });
}

// --- attempts that fail ---

/** How long a retry waits (`RETRY_DELAYS_MS`: 5 s, 20 s, 80 s, then minutes, then an hour). */
export const backoffMs = (tries: number): number => RETRY_DELAYS_MS[Math.min(Math.max(0, tries - 1), RETRY_DELAYS_MS.length - 1)] as number;
/** An attempt that failed for an infrastructure reason is tried again until it has been tried `MAX_ATTEMPTS` times in all; `tries` counts the retries already made. */
export function retryOf(failure: Pick<AttemptFailure, "infrastructure"> | null, tries: number): { readonly retry: true; readonly tries: number; readonly delayMs: number } | { readonly retry: false } {
  if (!failure?.infrastructure || tries + 1 >= MAX_ATTEMPTS) return { retry: false };
  return { retry: true, tries: tries + 1, delayMs: backoffMs(tries + 1) };
}

// --- after the work ---

export interface StepSettings {
  readonly agent: string | null;
  readonly reviewBy: string | null;
  readonly maxRounds: number;
  readonly targetScore: number | null;
  readonly approve: boolean;
  readonly candidates: number | readonly string[] | null;
  readonly judge: string | null;
}
/** The agents that attempt a step: one, or one per candidate. */
export function doers(settings: StepSettings): string[] {
  const { agent, candidates } = settings;
  if (Array.isArray(candidates)) return [...(candidates as readonly string[])];
  return agent === null ? [] : Array.from({ length: typeof candidates === "number" ? candidates : 1 }, () => agent);
}

export type WorkState = "active" | "succeeded" | "failed" | "held" | "stopped";
export interface WorkFacts {
  /** The latest work attempt of the round, per candidate. */
  readonly attempts: ReadonlyArray<{ readonly id: string; readonly state: WorkState; readonly detail?: string }>;
  /** A `task.ask` question nobody has answered yet. */
  readonly question: string | null;
  /** Sub-tasks the attempt added that are not done. */
  readonly openSubtasks: boolean;
  /** An approval the attempt left pending when it ended `held`. */
  readonly pendingApproval: string | null;
  /** An approved call of the held attempt is being carried out. */
  readonly acting: boolean;
}
export type AfterWork =
  | { readonly next: "wait" }
  | { readonly next: "needs"; readonly need: TaskNeed }
  | { readonly next: "subtasks" }
  | { readonly next: "check"; readonly attemptId: string }
  | { readonly next: "judge"; readonly by: string; readonly attemptIds: readonly string[] }
  | { readonly next: "again" }
  | { readonly next: "failed"; readonly detail: string };

/** What follows when a work attempt of the round has ended. */
export function afterWork(settings: StepSettings, facts: WorkFacts): AfterWork {
  if (facts.attempts.some((attempt) => attempt.state === "active")) return { next: "wait" };
  if (settings.candidates !== null) {
    const kept = facts.attempts.filter((attempt) => attempt.state === "succeeded").map((attempt) => attempt.id);
    if (kept.length === 0) return { next: "failed", detail: "No candidate produced a result" };
    return settings.judge === null || settings.judge === "person" ? { next: "needs", need: { kind: "judge", attemptIds: kept } } : { next: "judge", by: settings.judge, attemptIds: kept };
  }
  const attempt = facts.attempts[0];
  if (!attempt || attempt.state === "stopped") return { next: "wait" };
  if (attempt.state === "failed") return { next: "failed", detail: attempt.detail ?? "The attempt failed" };
  if (attempt.state === "held") {
    if (facts.pendingApproval !== null) return { next: "needs", need: { kind: "approval", approvalId: facts.pendingApproval } };
    return facts.acting ? { next: "wait" } : { next: "again" };
  }
  if (facts.question !== null) return { next: "needs", need: { kind: "answer", question: facts.question } };
  if (facts.openSubtasks) return { next: "subtasks" };
  return { next: "check", attemptId: attempt.id };
}

/** Who checks a result: the step's reviewer, else the `checker` agent, never the agent that produced it. Null means a person. */
export function checkerOf(settings: StepSettings, producedBy: string, agents: ReadonlySet<string>): string | null {
  const by = settings.reviewBy ?? "checker";
  return agents.has(by) && by !== producedBy ? by : null;
}

// --- the check ---

export interface Verdict { readonly pass: boolean; readonly score: number | null; readonly findings: string }
/** A checker's final answer, `{pass, score?, findings}`. Undefined when it is not that. */
export function readVerdict(result: string, output: JsonValue | null | undefined): Verdict | undefined {
  const value = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as { readonly [key: string]: JsonValue }) : resultObject(result);
  if (!value || typeof value["pass"] !== "boolean") return undefined;
  const score = typeof value["score"] === "number" && Number.isFinite(value["score"]) ? value["score"] : null;
  return { pass: value["pass"], score, findings: typeof value["findings"] === "string" ? value["findings"] : "" };
}
/** A check passes when the checker says so and, with a target score, the score reaches it. */
export const passes = (verdict: Verdict, targetScore: number | null): boolean => verdict.pass && (targetScore === null || (verdict.score ?? 0) >= targetScore);

export type AfterCheck =
  | { readonly next: "done" }
  | { readonly next: "needs"; readonly need: TaskNeed }
  | { readonly next: "again"; readonly round: number };
const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) ?? []);
/** Whether a check's findings say almost what the one before said: at least 0.6 of the words are shared (Jaccard), and there are enough of them to mean something. */
export function repeats(previous: string | undefined, current: string): boolean {
  if (previous === undefined) return false;
  const [a, b] = [words(previous), words(current)];
  // Too few words to compare by overlap: only the same words count (an identical block reason, an identical failed check).
  if (a.size < 8 || b.size < 8) return a.size > 0 && a.size === b.size && [...a].every((word) => b.has(word));
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared) >= 0.6;
}

/**
 * What follows a check by an agent: done (or a sign-off), another round with the findings, or a person once the rounds are used up, or at once when the
 * findings repeat the previous check's: another round would be asked for the same thing and change nothing.
 */
export function afterCheck(task: Pick<StepSettings, "maxRounds" | "targetScore" | "approve"> & { readonly round: number }, verdict: Verdict, previousFindings?: string): AfterCheck {
  if (passes(verdict, task.targetScore)) return task.approve ? { next: "needs", need: { kind: "sign-off" } } : { next: "done" };
  if (repeats(previousFindings, verdict.findings)) return { next: "needs", need: { kind: "check", findings: verdict.findings, repeated: true } };
  return task.round < task.maxRounds ? { next: "again", round: task.round + 1 } : { next: "needs", need: { kind: "check", findings: verdict.findings } };
}

/** What follows a person's `task.check`. A person's pass is final; their findings start another round, whatever the round count. */
export function afterPersonCheck(task: { readonly round: number; readonly needs: TaskNeed | null }, input: { readonly pass: boolean; readonly keep?: string | undefined }):
  | { readonly next: "done"; readonly attemptId?: string }
  | { readonly next: "again"; readonly round: number }
  | { readonly refused: string } {
  const need = task.needs;
  if (need?.kind !== "check" && need?.kind !== "sign-off" && need?.kind !== "judge") return { refused: "This task is not waiting for a check" };
  if (!input.pass) return { next: "again", round: task.round + 1 };
  if (need.kind !== "judge") return { next: "done" };
  if (input.keep === undefined || !need.attemptIds.includes(input.keep)) return { refused: "Name the candidate to keep" };
  return { next: "done", attemptId: input.keep };
}

/** A judge's final answer: `{"keep": <position from 1, or an attempt id>, "findings": "..."}`. Undefined when it names no candidate. */
export function readJudgement(result: string, output: JsonValue | null | undefined, attemptIds: readonly string[]): { readonly keep: string; readonly findings: string } | undefined {
  const value = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as { readonly [key: string]: JsonValue }) : resultObject(result);
  const named = value?.["keep"];
  const keep = typeof named === "number" ? attemptIds[named - 1] : typeof named === "string" && attemptIds.includes(named) ? named : undefined;
  return keep === undefined ? undefined : { keep, findings: typeof value?.["findings"] === "string" ? value["findings"] : "" };
}

// --- what an agent says it did ---

/** The reason an agent gave when it said it cannot do the task: a result whose first line starts with `BLOCKED:`. */
export function blockedReason(result: string): string | undefined {
  const first = result.trimStart().split("\n", 1)[0] ?? "";
  const match = /^BLOCKED:\s*(.*)$/iu.exec(first);
  return match ? (match[1]?.trim() || "no reason given") : undefined;
}

/** The files under `/out` and `/work` that a result says it saved, wrote or produced: the lines that say so are the claim, a path read or merely named is not. */
export function claimedFiles(result: string): string[] {
  const claims = new Set<string>();
  for (const line of result.split("\n")) {
    if (!/\b(?:sav|wr[io]t|creat|deliver|produc|stor)\w*/iu.test(line)) continue;
    for (const found of line.matchAll(/\/(?:out|work)\/[^\s`'"()[\]<>]+/gu)) {
      // /work/.workspace is the workspace's own files, given to read and never kept: naming it in a line that says "wrote" is not a claim.
      if (/^\/work\/\.workspace(?:\/|$)/u.test(found[0])) continue;
      // A brace list names several files: /out/logs/{a.txt,b.txt} claims /out/logs/a.txt and /out/logs/b.txt.
      const braces = /^(.*?)\{([^{}]*)\}(.*)$/u.exec(found[0]);
      for (const path of braces ? (braces[2] ?? "").split(",").map((part) => `${braces[1]}${part}${braces[3]}`) : [found[0]]) claims.add(path.replace(/[.,;:!?*]+$/u, ""));
    }
  }
  return [...claims];
}

/** What is wrong with the files a result claims, given the file names the attempt kept and the project folders of the workspace; undefined when nothing is. */
export function unkeptClaim(claims: readonly string[], kept: ReadonlySet<string>, projects: readonly string[]): string | undefined {
  const missing = claims.filter((claim) => {
    const [, root = "", ...rest] = claim.split("/");
    // A folder of /out is kept when a file under it is; a trailing slash names a folder.
    const name = rest.join("/").replace(/\/+$/u, "");
    return root === "out" ? name !== "" && !kept.has(name) && ![...kept].some((file) => file.startsWith(`${name}/`)) : !projects.includes(rest[0] ?? "");
  });
  if (missing.length === 0) return undefined;
  return `Your result says ${missing.map((path) => `"${path}"`).join(", ")} ${missing.length === 1 ? "was" : "were"} saved, but nothing was kept there: only files saved in /out${projects.length > 0 ? ` and changes to the project folders under /work (${projects.join(", ")})` : ""} are kept, and a file anywhere else is lost when the attempt ends. Save the file in /out, or take the claim out of your result.`;
}

// --- a plan ---

/** What an agent can do: the workspace tools it has, and whether it can write files (its native tools are at level `all`). */
export interface AgentCaps { readonly tools: readonly string[]; readonly writes: boolean }
/** The need of a task that saves files; the other needs are tool names. */
const WRITE_FILES = "files.write";

export interface PlannedTask { readonly title: string; readonly goal: string; readonly agent: string; readonly after: readonly string[] }
/**
 * A planner's final answer, `{summary, tasks: [{title, goal, agent, after, needs}]}`, checked against the workspace's agents. `after` holds titles
 * of earlier tasks. A task's needs are the ones the planner declares in `needs` (tools, and `files.write`): a goal that only names a tool or a file may be reviewing it, so the text of a goal is never read for needs. An agent that lacks one is replaced by the agent that has all of them and the fewest capabilities (the planner chose
 * by description and cannot see capabilities as plainly); the plan is refused only when no agent has them all.
 */
export function readPlan(result: string, output: JsonValue | null | undefined, agents: ReadonlyMap<string, AgentCaps>, tools: readonly string[] = []): { readonly summary: string; readonly tasks: readonly PlannedTask[]; readonly moved: readonly string[] } | { readonly problem: string } {
  const value = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as { readonly [key: string]: JsonValue }) : resultObject(result);
  const list = value?.["tasks"];
  if (!value || !Array.isArray(list)) return { problem: "The plan is not a JSON object with a list of tasks" };
  if (list.length === 0) return { problem: "The plan has no tasks" };
  const has = (agent: string, need: string): boolean => need === WRITE_FILES ? agents.get(agent)?.writes === true : agents.get(agent)?.tools.includes(need) === true;
  const weight = (agent: string): number => (agents.get(agent)?.tools.length ?? 0) + (agents.get(agent)?.writes ? 1 : 0);
  const tasks: PlannedTask[] = [];
  const moved: string[] = [];
  for (const [index, entry] of (list as readonly JsonValue[]).entries()) {
    const at = `Task ${index + 1} of the plan`;
    const task = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as { readonly [key: string]: JsonValue }) : {};
    const { title, goal } = task;
    let { agent } = task;
    if (typeof title !== "string" || title.trim() === "" || typeof goal !== "string" || goal.trim() === "" || typeof agent !== "string") return { problem: `${at} needs a title, a goal and an agent` };
    if (!agents.has(agent)) return { problem: `${at} names the agent "${agent}", which this workspace does not have` };
    const declared = Array.isArray(task["needs"]) ? (task["needs"] as readonly JsonValue[]) : [];
    const unknown = declared.find((need) => typeof need !== "string" || (need !== WRITE_FILES && !tools.includes(need)));
    if (unknown !== undefined) return { problem: `${at} needs "${String(unknown)}", which is neither a tool of this workspace nor ${WRITE_FILES}` };
    const needs = [...new Set(declared as readonly string[])];
    const lacking = needs.filter((need) => !has(agent as string, need));
    if (lacking.length > 0) {
      const fit = [...agents.keys()].filter((name) => needs.every((need) => has(name, need))).sort((x, y) => weight(x) - weight(y) || x.localeCompare(y))[0];
      if (fit === undefined) {
        const owners = lacking.map((need) => `${need} (agents that have it: ${[...agents.keys()].filter((name) => has(name, need)).join(", ") || "none"})`).join("; ");
        return { problem: `${at} gives a goal that needs ${lacking.join(", ")}, which the agent "${agent}" does not have, and no one agent has all of its needs: ${owners}` };
      }
      moved.push(`"${title.trim()}" goes to ${fit} instead of ${agent}: it has ${lacking.join(", ")}`);
      agent = fit;
    }
    if (tasks.some((earlier) => earlier.title === title)) return { problem: `${at} repeats the title "${title}"` };
    const after = Array.isArray(task["after"]) ? (task["after"] as readonly JsonValue[]) : [];
    const missing = after.find((name) => typeof name !== "string" || !tasks.some((earlier) => earlier.title === name));
    if (missing !== undefined) return { problem: `${at} waits for "${String(missing)}", which is not an earlier task of the plan` };
    tasks.push({ title: title.trim().slice(0, 200), goal, agent, after: after as readonly string[] });
  }
  return { summary: typeof value["summary"] === "string" ? value["summary"] : "", tasks, moved };
}

// --- a task with sub-tasks ---

export interface ChildFacts { readonly id: string; readonly state: TaskState; readonly result: string | null }
/**
 * The state of a task that only groups sub-tasks: done when all are done, needing a person when one failed or was stopped, running
 * otherwise. Its result is the result of its last sub-task that was not skipped; the copies of a `for_each` step give the list of theirs.
 */
export function groupOutcome(children: readonly ChildFacts[], copies: boolean): { readonly state: "running" } | { readonly state: "needs_you"; readonly need: Extract<TaskNeed, { kind: "failed-subtask" }> } | { readonly state: "done"; readonly result: string } {
  const broken = children.find((child) => child.state === "failed" || child.state === "stopped");
  if (broken) return { state: "needs_you", need: { kind: "failed-subtask", taskId: broken.id } };
  if (children.length === 0 || children.some((child) => child.state !== "done")) return { state: "running" };
  if (copies) return { state: "done", result: JSON.stringify(children.map((child) => child.result ?? "")) };
  return { state: "done", result: children.findLast((child) => child.result !== null && child.result !== SKIPPED)?.result ?? SKIPPED };
}
