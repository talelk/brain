import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureTasks, replayedServerTasks, type Check, type StandingTask } from "./fixtures";

/**
 * The runner of the standing test set: sends every fixture task to a model endpoint (OpenAI-compatible, the same one the workers use),
 * scores each answer with its deterministic check and reports first-pass success, attempts, tokens and time. A task gets at most two
 * attempts, like a real task's retry: first-pass success is the share that passed on the first.
 */
export const WORKER_PROMPT = "You are a careful assistant doing one task for a team. Answer only what was asked, concisely. If you were not given the data or tools you would need, say plainly that you cannot observe it; never invent facts, numbers or names.";
/** A drop of more than this many points of first-pass success against the baseline blocks a deploy. */
export const MAX_DROP_POINTS = 10;
export const MAX_ATTEMPTS = 2;

export interface Completion { readonly text: string; readonly tokens: number }
export type Complete = (messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<Completion>;
export interface TaskResult { readonly id: string; readonly kind: string; readonly passed: boolean; readonly attempts: number; readonly tokens: number; readonly ms: number; readonly failures: readonly string[] }
export interface Report {
  readonly at: string; readonly model: string; readonly fingerprint: string;
  readonly total: number; readonly firstPass: number; readonly firstPassRate: number; readonly passed: number;
  readonly attempts: number; readonly tokens: number; readonly ms: number; readonly results: readonly TaskResult[];
}
export interface Baseline { readonly firstPassRate: number; readonly model: string; readonly recordedAt: string }

export const allTasks = (): readonly StandingTask[] => [...fixtureTasks, ...replayedServerTasks];

/** What the fixtures, the worker prompt, the model and the release add up to: when it changes the set is run again. */
export function fingerprint(model: string, release = process.env["BRAIN_RELEASE_DIGEST"] ?? ""): string {
  const hash = createHash("sha256");
  hash.update(WORKER_PROMPT).update(model).update(release).update(JSON.stringify(allTasks()));
  return hash.digest("hex").slice(0, 16);
}

/** The failures of one answer against its check; empty when it passes. */
export function scoreAnswer(answer: string, check: Check): string[] {
  const failures: string[] = [];
  const text = answer.trim();
  for (const pattern of check.all ?? []) if (!new RegExp(pattern, "imu").test(text)) failures.push(`missing /${pattern}/`);
  for (const pattern of check.none ?? []) if (new RegExp(pattern, "imu").test(text)) failures.push(`must not match /${pattern}/`);
  if (check.jsonKeys) {
    try {
      const body = /\{[\s\S]*\}/u.exec(text)?.[0] ?? "";
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of check.jsonKeys) if (!(key in parsed)) failures.push(`json key ${key} missing`);
    } catch { failures.push("not a JSON object"); }
  }
  if (check.maxWords !== undefined && text.split(/\s+/u).filter(Boolean).length > check.maxWords) failures.push(`longer than ${check.maxWords} words`);
  return failures;
}

export async function runTask(task: StandingTask, complete: Complete, now: () => number = Date.now): Promise<TaskResult> {
  const started = now();
  let tokens = 0;
  let failures: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [
      { role: "system" as const, content: WORKER_PROMPT },
      { role: "user" as const, content: attempt === 1 ? task.prompt : `${task.prompt}\n\nYour previous answer failed these checks: ${failures.join("; ")}. Answer again.` },
    ];
    try {
      const answer = await complete(messages);
      tokens += answer.tokens;
      failures = scoreAnswer(answer.text, task.check);
    } catch (cause) { failures = [`model error: ${cause instanceof Error ? cause.message.slice(0, 120) : "unknown"}`]; }
    if (failures.length === 0) return { id: task.id, kind: task.kind, passed: true, attempts: attempt, tokens, ms: now() - started, failures: [] };
  }
  return { id: task.id, kind: task.kind, passed: false, attempts: MAX_ATTEMPTS, tokens, ms: now() - started, failures };
}

export async function runStandingTests(complete: Complete, model: string, tasks: readonly StandingTask[] = allTasks(), now: () => number = Date.now): Promise<Report> {
  const results: TaskResult[] = [];
  for (const task of tasks) results.push(await runTask(task, complete, now));
  const firstPass = results.filter((entry) => entry.passed && entry.attempts === 1).length;
  return {
    at: new Date().toISOString(), model, fingerprint: fingerprint(model), total: results.length, firstPass,
    firstPassRate: results.length ? firstPass / results.length : 0, passed: results.filter((entry) => entry.passed).length,
    attempts: results.reduce((sum, entry) => sum + entry.attempts, 0), tokens: results.reduce((sum, entry) => sum + entry.tokens, 0),
    ms: results.reduce((sum, entry) => sum + entry.ms, 0), results,
  };
}

/** Gate decision: block only when first-pass success fell by more than the allowed points against the recorded baseline. */
export function decideGate(report: Pick<Report, "firstPassRate">, baseline: Baseline | undefined): { block: boolean; message: string } {
  const now = Math.round(report.firstPassRate * 1000) / 10;
  if (!baseline) return { block: false, message: `first-pass success ${now}%; no baseline recorded yet (run with --record-baseline)` };
  const before = Math.round(baseline.firstPassRate * 1000) / 10;
  const drop = Math.round((before - now) * 10) / 10;
  if (drop > MAX_DROP_POINTS) return { block: true, message: `first-pass success fell from ${before}% to ${now}% (${drop} points, more than ${MAX_DROP_POINTS}): the deploy is blocked` };
  return { block: false, message: `first-pass success ${now}% against a baseline of ${before}% (${drop > 0 ? `down ${drop}` : "no drop"} points)` };
}

export function modelConfig(env: NodeJS.ProcessEnv = process.env): { url: string; model: string; apiKey: string | undefined } {
  return { url: (env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1").replace(/\/$/u, ""), model: env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b", apiKey: env["BRAIN_LOCAL_MODEL_API_KEY"] };
}

/** Whether the endpoint answers and serves the model. A model that cannot be reached skips the set; it never fails it. */
export async function modelReachable(config: ReturnType<typeof modelConfig>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${config.url}/models`, { redirect: "error", headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    return body.data?.some((entry) => entry.id === config.model) === true;
  } catch { return false; }
}

export function chatCompletion(config: ReturnType<typeof modelConfig>, fetchImpl: typeof fetch = fetch): Complete {
  return async (messages) => {
    const response = await fetchImpl(`${config.url}/chat/completions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(180_000),
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, temperature: 0, max_tokens: 1200, messages }),
    });
    if (!response.ok) throw new Error(`model answered HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    return { text: body.choices?.[0]?.message?.content ?? "", tokens: body.usage?.total_tokens ?? 0 };
  };
}

const here = new URL(".", import.meta.url).pathname;
export const BASELINE_FILE = join(here, "baseline.json");
export const REPORT_DIR = join(here, "../../.cache/standing-tests");

export function readBaseline(file = BASELINE_FILE): Baseline | undefined {
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Baseline>;
  return typeof value.firstPassRate === "number" ? { firstPassRate: value.firstPassRate, model: String(value.model ?? ""), recordedAt: String(value.recordedAt ?? "") } : undefined;
}
export function writeBaseline(report: Report, file = BASELINE_FILE): void {
  writeFileSync(file, `${JSON.stringify({ firstPassRate: report.firstPassRate, model: report.model, recordedAt: report.at, fingerprint: report.fingerprint, total: report.total }, null, 2)}\n`);
}
export function saveReport(report: Report, dir = REPORT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.at.replace(/[:.]/gu, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
/** The fingerprint of the newest saved report, so a nightly run can skip when nothing changed. */
export function lastFingerprint(dir = REPORT_DIR): string | undefined {
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().at(-1);
  return newest ? (JSON.parse(readFileSync(join(dir, newest), "utf8")) as { fingerprint?: string }).fingerprint : undefined;
}

export function summaryLines(report: Report): string[] {
  const failed = report.results.filter((entry) => !entry.passed);
  return [
    `standing tests on ${report.model} (${report.fingerprint}): ${report.total} tasks`,
    `  first-pass success ${Math.round(report.firstPassRate * 1000) / 10}% (${report.firstPass}/${report.total}), passed after retry ${report.passed - report.firstPass}, failed ${failed.length}`,
    `  attempts ${report.attempts}, tokens ${report.tokens}, time ${Math.round(report.ms / 1000)}s`,
    ...failed.map((entry) => `  FAIL ${entry.id}: ${entry.failures.join("; ")}`),
  ];
}
