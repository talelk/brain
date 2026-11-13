import type { JobSnapshot, JsonValue, TaskDraft } from "@brain/contracts";
import type { MessageKey } from "../i18n";
import { governor } from "./client";

/**
 * The installation check on Today: the read-only verify-installation task, started with its fixed input in one go.
 * It uses the same two Governor calls the play page's Review and Start buttons use (prepare a draft, start it);
 * nothing here decides whether the install works, the run's own state does.
 */
const CHECK_INPUT: JsonValue = { message: "BRAIN_OK" };
export const CHECK_WORKFLOW = "agent-smoke";

/** Prepare the exact draft and start it; the returned run id is what the Today row then follows through the live store. */
export async function startInstallCheck(workspaceId: string, workflowId: string = CHECK_WORKFLOW): Promise<string> {
  const draft = await governor<TaskDraft>("/v1/tasks/drafts", { workspaceId, workflowId, input: CHECK_INPUT });
  const started = await governor<TaskDraft>(`/v1/tasks/drafts/${encodeURIComponent(draft.id)}/start`, { workspaceId });
  if (!started.runId) throw new Error("The check was not accepted.");
  return started.runId;
}

type CheckOutcome = "running" | "passed" | "failed";

/** Where a started check stands, from the run's own state (a job state is used only before the run state is known). */
export function checkOutcome(job: Pick<JobSnapshot, "state" | "runState">): CheckOutcome {
  const state = job.runState ?? job.state;
  if (state === "succeeded") return "passed";
  if (state === "failed" || state === "partial" || state === "cancelled" || state === "outcome_unknown") return "failed";
  return "running";
}

/** Why a failed check failed, as a catalogue key a person can read. The engine's own stop reason is used when the run recorded one. */
export function failureKey(job: Pick<JobSnapshot, "state" | "runState" | "engineEvents">): MessageKey {
  const stopped = [...(job.engineEvents ?? [])].reverse().map((event) => event as { kind?: string; payload?: { reason?: string } }).find((event) => event.kind === "session.stopped");
  const reason = stopped?.payload?.reason;
  if (reason === "timeout") return "today.check.fail.timeout";
  if (reason === "budget") return "today.check.fail.budget";
  if (reason === "error") return "today.check.fail.error";
  if ((job.runState ?? job.state) === "cancelled" || reason === "cancelled") return "today.check.fail.cancelled";
  if (reason === "completed") return "today.check.fail.answer";
  return "today.check.fail.generic";
}

/** While a check has not started working: the plain reason it is waiting, if the run recorded one. */
export function waitingKey(job: Pick<JobSnapshot, "queueReasons">): MessageKey | undefined {
  const reasons = job.queueReasons ?? [];
  if (reasons.includes("WAITING_FOR_RUNNER") || reasons.includes("RUNNER_OFFLINE")) return "today.check.waiting.runner";
  if (reasons.includes("INSUFFICIENT_CAPACITY") || reasons.includes("WAITING_FOR_RESOURCE") || reasons.includes("FAIRNESS_DELAY")) return "today.check.waiting.busy";
  return undefined;
}

/** "4 s" or "1 min 5 s": how long a check took, to the second. */
export function takenLabel(ms: number): { readonly minutes: number; readonly seconds: number } {
  const total = Math.max(1, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
