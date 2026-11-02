/**
 * Pure classification of execution records: severity and emitter derivation.
 * No IO — the projector and tests call these directly so two builders of the
 * same record cannot diverge.
 */

export type StreamSeverity = "debug" | "info" | "warning" | "error" | "critical";
export type StreamEmitter = "agent" | "tool" | "runner" | "governor" | "evaluator" | "connector" | "system";
export type StreamSource = "control" | "workspace" | "attempt";

export const STREAM_SEVERITIES: readonly StreamSeverity[] = ["debug", "info", "warning", "error", "critical"];
export const STREAM_EMITTERS: readonly StreamEmitter[] = ["agent", "tool", "runner", "governor", "evaluator", "connector", "system"];

/** Event-type families mapped to the Governor process by default. */
const GOVERNOR_PREFIXES: readonly string[] = [
  "job.", "workflow.", "config.", "configDraft.", "dispatch.", "membership.", "workspace.", "organization.",
  "identity.", "knowledge.", "objective.", "plan.", "workItem.", "board.", "decision.", "delegation.",
  "capability.", "capitalization.", "memory.", "document.", "approval.",
];

/**
 * The Logs source filter's 7-way emitter taxonomy. Attempt rows arrive with
 * their event type already mapped (engine kinds surface verbatim; progress and
 * effect wire kinds become attempt.progress / attempt.effect). Any unlisted
 * type maps to governor — the Governor process emitted it — so no NULL bucket
 * can appear.
 */
export function emitterOf(source: StreamSource, eventType: string): StreamEmitter {
  if (eventType === "workItem.message") return "agent";
  if (eventType === "attempt.effect" || eventType.startsWith("tool.")) return "tool";
  if (source === "attempt") return eventType === "attempt.progress" ? "governor" : "agent";
  if (eventType.startsWith("session.")) return "agent";
  if (eventType.startsWith("runner.")) return "runner";
  if (eventType.startsWith("evidence.")) return "evaluator";
  if (eventType.startsWith("integration.")) return "connector";
  if (eventType.startsWith("operations.") || eventType.startsWith("local-runtime.") || eventType.startsWith("reconciliation.")) return "system";
  if (GOVERNOR_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return "governor";
  return "governor";
}

/**
 * Severity where the record supplies a basis for it; everything else is info.
 */
export function severityOf(source: StreamSource, eventType: string, payload: Record<string, unknown> | null): StreamSeverity {
  void source;
  if (eventType === "operations.restored-authority-quarantined") return "critical";
  if (eventType === "error") return "error";
  if (eventType === "session.stopped") {
    const reason = String(payload?.["reason"] ?? "");
    return reason === "error" || reason === "budget" || reason === "timeout" ? "error" : "info";
  }
  if (eventType === "tool.result") {
    const receipt = (payload?.["receipt"] ?? null) as Record<string, unknown> | null;
    const result = String(receipt?.["result"] ?? "");
    if (result === "failed") return "error";
    if (result === "partial" || result === "unknown") return "warning";
    return "info";
  }
  if (eventType === "text") return String(payload?.["channel"] ?? "") === "diagnostic" ? "debug" : "info";
  return "info";
}
