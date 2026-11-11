import { createSignal } from "solid-js";
import type { LogRecord } from "./LogTail";

/**
 * Readable log mode: every record as one plain sentence (who did what, for
 * which task). Pure over the record plus a task-title lookup; the raw record
 * stays one click away in the row's detail pane. Unknown event types fall back
 * to a humanised type name, never to invented meaning.
 */

export interface TaskInfo {
  readonly title: string;
  readonly state: string;
  readonly verified: boolean;
  readonly parked: boolean;
  readonly failedAttempts: number;
  readonly blockedReason?: string | undefined;
}

const [taskInfo, setTaskInfo] = createSignal<Readonly<Record<string, TaskInfo>>>({});
export { setTaskInfo, taskInfo };

/** One line saying where a task stands, in the words of the mission page. */
export function taskStatusLine(info: TaskInfo | undefined): string {
  if (!info) return "no longer listed";
  if (info.parked) return `parked after ${info.failedAttempts} failed ${info.failedAttempts === 1 ? "attempt" : "attempts"}`;
  switch (info.state) {
    case "done": return info.verified ? "finished, verified" : "finished";
    case "review": return "waiting for review";
    case "in-progress": return "working";
    case "blocked": return info.blockedReason ? `blocked: ${info.blockedReason}` : "blocked";
    case "abandoned": return "dropped";
    case "ready": return "ready to start";
    default: return "not started";
  }
}

const ACTORS: Record<string, string> = {
  agent: "The agent",
  tool: "A tool",
  runner: "The runner",
  governor: "Brain",
  evaluator: "The checker",
  connector: "A connector",
  system: "Brain",
};

/** What happened, as a verb phrase after the actor. */
const ACTIONS: Record<string, string> = {
  "mission.created": "created the mission",
  "mission.stateChanged": "changed the mission's state",
  "mission.briefChanged": "updated the mission brief",
  "mission.budgetChanged": "changed the mission budget",
  "mission.policyChanged": "changed how the mission starts work",
  "mission.messageSent": "sent a message to the mission",
  "mission.verdictRecorded": "recorded the verdict on the mission",
  "mission.bundleAssembled": "gathered the mission's evidence",
  "plan.proposed": "drafted a plan",
  "plan.confirmed": "confirmed the plan",
  "plan.autoConfirmed": "confirmed the plan automatically",
  "plan.rejected": "turned the plan down",
  "workItem.transitioned": "moved the task to its next stage",
  "workItem.parked": "parked the task after repeated failures",
  "workItem.unparked": "took the task out of parking",
  "workItem.comment": "left a note on the task",
  "job.queued": "queued the work for a runner",
  "attempt.progress": "reported progress",
  "attempt.effect": "made a change",
  "attempt.started": "started an attempt",
  "attempt.succeeded": "finished an attempt successfully",
  "attempt.failed": "had an attempt fail",
  "session.created": "opened a session",
  "session.started": "started working",
  "session.resumed": "picked the session back up",
  "session.stopped": "stopped the session",
  "session.checkpointed": "saved a checkpoint",
  "session.delegated": "handed part of the work to another member",
  usage: "reported how much it used",
  "tool.proposed": "asked to use a tool",
  "tool.result": "finished using a tool",
  "approval.requested": "asked for approval",
  "approval.decision": "recorded an approval decision",
  "output.versionRecorded": "saved a new version of an output",
  "runner.quarantined": "set the runner aside",
  "runner.draining": "is finishing its work before stopping",
  "workflow.succeeded": "finished the workflow successfully",
  "workflow.suspended": "paused the workflow",
  text: "said",
};

function humanise(type: string): string {
  return type.replace(/[._-]+/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function payloadOf(record: LogRecord): Record<string, unknown> | undefined {
  return record.summary && typeof record.summary === "object" && !Array.isArray(record.summary) ? record.summary as Record<string, unknown> : undefined;
}

/** The task an event belongs to, when its correlation names one that is known. */
export function taskOfRecord(record: LogRecord): string | undefined {
  const id = record.correlation?.workItemId;
  return id ? taskInfo()[id]?.title : undefined;
}

/** One plain sentence for a record; the tool name, text or failure reason is added when the record carries it. */
export function plainSentence(record: LogRecord, toolName?: string, text?: string, withTask = true, partialStart = false): string {
  const actor = ACTORS[record.emitter] ?? "Brain";
  const action = ACTIONS[record.type];
  const task = withTask ? taskOfRecord(record) : undefined;
  const forTask = task ? ` for "${task}"` : "";
  const payload = payloadOf(record);
  if (record.type === "text") {
    const said = text ?? (typeof payload?.["text"] === "string" ? payload["text"] : "");
    const spoken = describeSaid(said, partialStart);
    return spoken.kind === "text" ? `${actor} said${forTask}: ${spoken.text}` : `${actor} ${spoken.text}${forTask}.`;
  }
  if (record.type === "tool.proposed" || record.type === "tool.result") {
    const name = toolName && toolName !== "tool invocation" ? ` ${toolName}` : "";
    return `${actor === "A tool" ? "The agent" : actor} ${record.type === "tool.proposed" ? "asked to use the tool" : "finished using the tool"}${name}${forTask}.`;
  }
  const reason = record.severity === "error" || record.severity === "critical"
    ? ` It reported a problem${typeof payload?.["message"] === "string" ? `: ${payload["message"]}` : ""}.`
    : "";
  return `${actor} ${action ?? `recorded: ${humanise(record.type)}`}${forTask}.${reason}`;
}

/** The first ~200 characters, cut at a word boundary, with markdown noise removed. */
function lead(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").replace(/\*\*|__|`/gu, "").replace(/^#+\s*/u, "").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/u, "")}…`;
}

const JSON_KEYS = /"[A-Za-z_][\w-]*"\s*:/u;

/** What a streamed message amounts to: prose to quote, or a structured payload to name. */
export function describeSaid(raw: string, partialStart = false): { kind: "text" | "structured"; text: string } {
  let said = raw.trim();
  if (partialStart && /^[a-z]/u.test(said)) {
    const space = said.search(/\s/u);
    said = space > 0 ? `…${said.slice(space)}` : said;
  }
  const bare = said.replace(/^…\s*/u, "");
  const head = bare.slice(0, 400);
  if (/^[[{]/u.test(bare) || JSON_KEYS.test(head) || (/^["',.\]}]/u.test(bare) && /[{}[\]]/u.test(bare.slice(0, 40)))) {
    try {
      const parsed = JSON.parse(bare) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.keys(parsed).some((key) => /^(draft|document|content|body|deliverable)$/iu.test(key))) {
        return { kind: "structured", text: "delivered the draft" };
      }
    } catch { /* partial or invalid JSON is still structured */ }
    return { kind: "structured", text: "shared a structured result. Open the row to read it" };
  }
  return { kind: "text", text: lead(said) || "(nothing readable)" };
}
