/**
 * Failure classes and their single remedies (ADR 0022). The class is a code, never a sentence; the Governor decides it from the
 * call record, the step error and the checks that failed, never from a model.
 */
export const FAILURE_CLASSES = ["missing-tool", "unmeetable-criterion", "model-slip", "tool-outage", "budget", "unclassified"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type Remedy = "switch-way-of-working" | "stronger-model" | "ask-one-question" | "wait-and-retry" | "park-budget" | "retry";

/** Exactly one remedy per class. */
export const REMEDY: Readonly<Record<FailureClass, Remedy>> = {
  "missing-tool": "switch-way-of-working",
  "model-slip": "stronger-model",
  "unmeetable-criterion": "ask-one-question",
  "tool-outage": "wait-and-retry",
  budget: "park-budget",
  unclassified: "retry",
};

/** Default spend cap per task across all attempts; an owner can raise it for one task. */
export const DEFAULT_TASK_TOKEN_CAP = 200_000;
/** A tool outage is waited out this long before the next attempt, at most this many times (then the task parks like any failure). */
export const OUTAGE_WAIT_MS = 5 * 60_000;
export const OUTAGE_MAX_WAITS = 3;

export interface FailureSignals {
  /** Tools the task must observe (any one). */
  readonly requiredTools: readonly string[];
  /** Tools of the agents of the way of working the failed run used, when known. */
  readonly agentTools: readonly string[] | undefined;
  /** Recorded calls of the required tools in the task's runs. */
  readonly calls: { readonly succeeded: number; readonly failed: number; readonly outageLike: number };
  /** Ids of the checks the independent verdict did not pass. */
  readonly failedChecks: readonly string[];
  /** Failed attempts of this task before this one that failed the same checks. */
  readonly earlierSameChecks: number;
  readonly tokensUsed: number;
  readonly tokenCap: number;
  /** The step's own error text, if any. */
  readonly errorText: string;
}

const OUTAGE_TEXT = /\b(timed? ?out|timeout|aborted|unreachable|unavailable|econn\w*|enotfound|socket|launcher|sandboxed execution failed|bad gateway|502|503|504|connection (?:refused|reset))\b/iu;
const MISSING_TOOL_TEXT = /\btool\b[^.\n]{0,60}\b(?:is not|isn't|not) (?:available|installed|declared|found)\b|\bno such tool\b|\bunknown tool\b/iu;
const MALFORMED_TEXT = /\b(malformed|unparsable|unparseable|invalid json|could not parse|not valid json)\b/iu;

/** Whether a recorded tool failure message looks like the tool or its host being down rather than refusing the request. */
export const outageLike = (message: string | null | undefined): boolean => OUTAGE_TEXT.test(message ?? "");

/** The class of one failed attempt. Order matters: money first, then what the agent was given, then what happened. */
export function classifyFailure(signals: FailureSignals): FailureClass {
  if (signals.tokensUsed >= signals.tokenCap) return "budget";
  const needs = signals.requiredTools.length > 0;
  if (needs && signals.agentTools && !signals.requiredTools.some((tool) => signals.agentTools?.includes(tool))) return "missing-tool";
  if (MISSING_TOOL_TEXT.test(signals.errorText)) return "missing-tool";
  if (needs && signals.calls.succeeded === 0 && signals.calls.failed > 0) {
    // Every call failed: the tool or its host was down, or the tool refused what the criteria ask for.
    return signals.calls.outageLike === signals.calls.failed ? "tool-outage" : "unmeetable-criterion";
  }
  if (OUTAGE_TEXT.test(signals.errorText)) return "tool-outage";
  // The same criteria failed again although the tools worked: the criterion itself is the problem.
  if (signals.failedChecks.includes("criteria-met") && signals.earlierSameChecks > 0 && (!needs || signals.calls.succeeded > 0)) return "unmeetable-criterion";
  if (signals.failedChecks.length > 0 || MALFORMED_TEXT.test(signals.errorText)) return "model-slip";
  // A required tool was never called although it was available: the model skipped the work.
  if (needs && signals.calls.succeeded === 0 && signals.calls.failed === 0) return "model-slip";
  return "unclassified";
}

const LESSON: Readonly<Record<FailureClass, string>> = {
  "missing-tool": "its way of working lacked a tool the task needs: plan it with a way of working whose agent has that tool",
  "unmeetable-criterion": "a criterion could not be met as written: split the task or ask one question before planning it",
  "model-slip": "the model's answer did not hold up under check: state the criteria concretely and require evidence from tool calls",
  "tool-outage": "a tool was down when the task ran: it succeeds when retried later, so do not plan around it",
  budget: "the task used its whole token allowance across attempts: plan it as smaller tasks",
  unclassified: "it failed without a clear cause: keep the task small and the criteria checkable",
};

/** One plain sentence for the planner. */
export function lessonText(failureClass: FailureClass, title: string, outcome: "healed" | "parked"): string {
  const head = outcome === "healed" ? `Task "${title.slice(0, 120)}" failed first and then succeeded` : `Task "${title.slice(0, 120)}" was parked`;
  return `${head}; ${LESSON[failureClass]}.`;
}
