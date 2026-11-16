import type { AttemptEventBody, AttemptFailure, AttemptUsage, JsonValue } from "@brain/contracts";
import { failureKind } from "./failure-detail";
import { decodeModelJson, wholeJsonObject } from "./json-reply";
import { overAllowanceReason } from "./limits";
import type { EngineAdapter, EngineSessionSpec } from "./port";
import { SANDBOX_REFUSAL } from "./sandboxed";

/** Why the runner aborted an attempt; carried as the reason of its abort signal. */
export type AbortCause = "stopped" | "lease" | "timeout";
export const abortCause = (signal: AbortSignal): AbortCause | undefined => (signal.aborted ? (["stopped", "lease", "timeout"] as const).find((cause) => cause === signal.reason) ?? "stopped" : undefined);

export interface SessionRequest {
  readonly engine: EngineAdapter;
  readonly spec: EngineSessionSpec;
  /** Carries out a workspace or Brain-run tool call and returns the text the model is shown. */
  readonly executeTool: (tool: string, input: JsonValue) => Promise<string>;
  readonly emit: (event: AttemptEventBody) => void;
  /** The attempt's abort signal; its reason is an `AbortCause`. */
  readonly signal: AbortSignal;
  /** What earlier sessions of this attempt used: usage is reported as the attempt's total. */
  readonly usedBefore?: AttemptUsage & { readonly turns: number };
}

export interface SessionResult {
  readonly ok: boolean;
  /** The agent's answer: what it wrote as its final message. */
  readonly text: string;
  readonly usage: AttemptUsage & { readonly turns: number };
  readonly failure?: AttemptFailure;
  readonly output?: JsonValue;
}

const NO_USE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0, turns: 0 };
/** The Governor shows a failure's detail to a person; the runner never sends more than this of an engine's message. */
const DETAIL_CHARS = 500;

function failed(reason: AttemptFailure["reason"], detail: string, infrastructure = false): AttemptFailure {
  return { reason, detail: detail.replace(/\s+/gu, " ").trim().slice(0, DETAIL_CHARS), infrastructure };
}

/** What an engine's own failure is for the task: a model that refused or did not answer is not the task's doing, so the attempt may be retried as it is. */
export function engineFailure(detail: string): AttemptFailure {
  if (detail.includes(SANDBOX_REFUSAL)) return failed("runner", detail, true);
  const kind = failureKind(detail);
  return kind === "model-refused" ? failed("model-refused", detail, true) : failed("engine", detail, kind === "endpoint");
}

/** One engine session from start to its terminal event, with the agent's limits and the attempt's time limit enforced. */
export async function runSession(request: SessionRequest): Promise<SessionResult> {
  const { engine, spec, emit } = request;
  const before = request.usedBefore ?? NO_USE;
  let usage = before;
  let text = "";
  let failure: AttemptFailure | undefined;
  let stopped: { reason: string; detail?: string } | undefined;
  const session = new AbortController();
  const onAbort = (): void => session.abort(request.signal.reason);
  if (request.signal.aborted) onAbort(); else request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => session.abort("timeout" satisfies AbortCause), spec.limits.timeoutMs);
  /** A session that is still working past the agent's limits is stopped; one whose answer is being written is not. */
  const overLimit = (): boolean => {
    const over = overAllowanceReason({ tokens: usage.inputTokens + usage.outputTokens + usage.cachedInputTokens, microUsd: usage.microUsd, turns: usage.turns }, spec.limits);
    if (over && !failure) { failure = failed("limit", over); void engine.cancel().catch(() => undefined); }
    return over !== undefined;
  };
  try {
    await engine.start(spec, session.signal);
    for await (const event of engine.events(session.signal)) {
      switch (event.kind) {
        case "text": if (event.channel === "assistant") text += event.text; emit(event); break;
        case "native.call": emit(event); overLimit(); break;
        case "native.result": emit(event); break;
        case "tool.request":
          await engine.toolResult(event.callId, overLimit() ? JSON.stringify({ refused: true, error: "This attempt's allowance is used up." }) : await request.executeTool(event.tool, event.input));
          break;
        case "usage":
          usage = { inputTokens: before.inputTokens + event.inputTokens, outputTokens: before.outputTokens + event.outputTokens, cachedInputTokens: before.cachedInputTokens + event.cachedInputTokens, microUsd: before.microUsd + event.microUsd, turns: before.turns + event.turns };
          emit({ kind: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, microUsd: usage.microUsd });
          break;
        case "stopped": stopped = event; break;
      }
      if (stopped) break;
    }
  } catch (error) {
    failure ??= engineFailure(error instanceof Error ? error.message : "the engine failed");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    await Promise.race([engine.dispose().catch(() => undefined), new Promise((resolve) => { setTimeout(resolve, 2000).unref(); })]);
  }
  const cause = abortCause(session.signal);
  if (cause === "timeout") failure = failed("timeout", `the attempt ran longer than ${Math.round(spec.limits.timeoutMs / 1000)} seconds and was stopped`);
  else if (cause === "lease") failure = failed("runner", "the lease on the attempt was lost", true);
  else if (cause === "stopped") failure = failed("stopped", "the attempt was stopped");
  else if (!failure) {
    if (!stopped) failure = failed("engine", "the engine's event stream ended without a result");
    else if (stopped.reason === "limit") failure = failed("limit", stopped.detail ?? "the agent's limits were reached");
    else if (stopped.reason === "timeout") failure = failed("timeout", stopped.detail ?? "the engine timed out");
    else if (stopped.reason !== "completed") failure = engineFailure(stopped.detail ?? `the engine ended with ${stopped.reason}`);
    else if (!text.trim()) failure = failed("engine", "the agent finished without writing an answer");
  }
  return { ok: failure === undefined, text, usage, ...(failure ? { failure } : {}) };
}

/** The JSON a kind's final answer must be: how to say it to the agent, and what is wrong with a decoded value (nothing when it is right). */
export interface AnswerFormat {
  readonly shape: string;
  readonly problems: (value: JsonValue) => readonly string[];
}

const CORRECTION_CHARS = 30_000;
/** The first line of a corrective session's task; the fixture engine reads it to know it is asked for a correction. */
export const CORRECTION_HEADER = "[correction of the final answer]";
function correctiveTask(previous: string, format: AnswerFormat, problems: readonly string[]): string {
  const listed = problems.slice(0, 8).map((problem) => `- ${problem.slice(0, 300)}`).join("\n");
  return `${CORRECTION_HEADER}\nYour previous reply could not be used: the final answer of this task must be one JSON object of this form and nothing else:\n${format.shape}\n\nWhat is wrong with it:\n${listed}\n\nReply again with only the complete corrected JSON object: the same content, valid JSON, every double quote and backslash inside a string escaped, no text, code fence or comment around it.\n\nYour previous reply:\n${previous.trim().slice(0, CORRECTION_CHARS)}`;
}

function problemsOf(text: string, format: AnswerFormat): { value?: JsonValue; problems: readonly string[] } {
  const decoded = decodeModelJson(text);
  if (!decoded || decoded.value === null || typeof decoded.value !== "object" || Array.isArray(decoded.value)) return { problems: ["the reply is not a JSON object"] };
  return { value: decoded.value, problems: format.problems(decoded.value) };
}

/**
 * Runs the engine for an attempt. Without a format the answer is the result as written, and it is also the structured output when the
 * whole of it is a JSON object. With a format (plan, check, judge) the answer must be that JSON: a reply that is not gets one corrective
 * session, which sees its own reply and what is wrong with it and has no tools; if that does not produce it either, the attempt fails
 * and says so. Both sessions count: usage is the attempt's total.
 */
export async function runEngine(request: SessionRequest, format?: AnswerFormat): Promise<SessionResult> {
  const first = await runSession(request);
  if (!first.ok) return first;
  if (!format) { const output = wholeJsonObject(first.text); return output === undefined ? first : { ...first, output }; }
  const judged = problemsOf(first.text, format);
  if (judged.problems.length === 0) return { ...first, output: judged.value! };
  // A reply that is not the required JSON is a flake of the model, not a fault of the task: the Governor tries again (three times at most).
  const wrong = (problems: readonly string[]): AttemptFailure => failed("engine", `the agent's final answer is not the required JSON (${format.shape}): ${problems.join("; ")}`, true);
  // The correction is part of the same allowance: with little of it left the first reply stands and the attempt fails on it.
  const used = first.usage.inputTokens + first.usage.outputTokens + first.usage.cachedInputTokens;
  const allowance = request.spec.limits.maxTokens;
  if (request.signal.aborted || (allowance > 0 && used > allowance * 0.8)) return { ...first, ok: false, failure: wrong(judged.problems) };
  const second = await runSession({
    ...request, usedBefore: first.usage,
    spec: { ...request.spec, task: correctiveTask(first.text, format, judged.problems), tools: [], native: "none" },
  });
  if (!second.ok) return second.failure?.reason === "engine" ? { ...second, text: first.text, failure: wrong(judged.problems) } : { ...second, text: first.text };
  const corrected = problemsOf(second.text, format);
  if (corrected.problems.length > 0) return { ...second, ok: false, text: first.text, failure: wrong(corrected.problems) };
  return { ...second, output: corrected.value! };
}
