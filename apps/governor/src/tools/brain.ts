import { BrainError, isSlug, type BrainToolRequest, type BrainToolResponse, type Digest, type JsonValue, type ToolOutcome } from "@brain/contracts";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { openPullRequest, pullRequestPatch } from "../integrations/pull-request";
import { postTeams } from "../integrations/teams";
import { proposeMemory, searchMemory } from "../memory/memory";
import { settle } from "../tasks/orchestrator";
import { insertTask, taskOf, type AttemptRow, type TaskRow } from "../tasks/store";
import { authorizeCall, callRowId, finishCall, openCall } from "../trust/approvals";
import { manifestOf } from "../workspace/store";
import { inputProblem, ToolRefusal } from "./schema";

/**
 * The tools the Governor carries out itself, as the attempt that calls them (docs/architecture.md section 7; inputs and outputs in
 * packs/README.md). Every call is recorded; one with an effect waits for its approval like any other.
 */
const MAX_SUBTASKS = 20;
type Input = { readonly [name: string]: JsonValue };

/** The tools that only touch Brain's own record: they run inside the transaction that records the call. */
function runNow(gov: Gov, attempt: AttemptRow, task: TaskRow, tool: string, input: Input): JsonValue {
  const { db } = gov;
  const actor = { kind: "agent" as const, id: attempt.agent, attemptId: attempt.id };
  if (tool === "task.note") {
    const id = db.prepare("INSERT INTO notes(workspace_id, root_id, author, attempt_id, text, created_at_ms) VALUES (?,?,?,?,?,?)").run(task.workspace_id, task.root_id, attempt.agent, attempt.id, input["text"] as string, gov.clock.nowMs()).lastInsertRowid;
    return { id: String(id) };
  }
  if (tool === "memory.search") return { results: searchMemory(db, task.workspace_id, input["query"] as string, (input["limit"] as number | undefined) ?? 5) };
  if (tool === "memory.propose") {
    if (!isSlug(input["name"] as string)) throw new ToolRefusal("The name must be lower-case words joined by hyphens, such as release-checklist");
    return { id: proposeMemory(gov, attempt, { name: input["name"] as string, title: input["title"] as string, text: input["text"] as string }), status: "proposed" };
  }
  // The two below change the course of the task itself, so only its own work may use them.
  if (attempt.kind !== "work" || attempt.candidate !== null) throw new ToolRefusal(`${tool} is only for the attempt that does a task's work, and not for one of several candidates`);
  if (tool === "task.ask") return { status: "waiting" };
  const agent = input["agent"] as string;
  const agents = Object.keys(manifestOf(gov, task.snapshot_digest).agents);
  if (!agents.includes(agent)) throw new ToolRefusal(`There is no agent "${agent}". The agents of this workspace are: ${agents.join(", ")}`);
  const after = (input["after"] as string[] | undefined) ?? [];
  const siblings = new Set((db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(task.id) as Array<{ id: string }>).map((row) => row.id));
  const unknown = after.find((id) => !siblings.has(id));
  if (unknown !== undefined) throw new ToolRefusal(`"${unknown}" is not a sub-task of your task; after takes ids that earlier task.create calls returned`);
  if (siblings.size >= MAX_SUBTASKS) throw new ToolRefusal(`A task has at most ${MAX_SUBTASKS} sub-tasks`);
  const child = insertTask(gov, actor, {
    workspaceId: task.workspace_id, parent: task, snapshotDigest: task.snapshot_digest, title: (input["title"] as string).trim().slice(0, 200) || "Sub-task", goal: input["goal"] as string, agent, state: "waiting",
    createdBy: `agent:${attempt.id}`, after,
  });
  // The calling task waits for its sub-task: when its attempt ends it is run again, with the sub-task's result in its context.
  db.prepare("INSERT INTO task_deps(task_id, waits_for) VALUES (?,?)").run(task.id, child.id);
  settle(gov, task.workspace_id);
  return { id: child.id };
}

/** The tools that reach another server. They run after the call is recorded and approved, outside any transaction. */
async function runOutside(gov: Gov, attempt: AttemptRow, task: TaskRow, tool: string, input: Input, patchDigest: Digest | undefined): Promise<JsonValue> {
  if (tool === "message.send") {
    await postTeams(gov, task.workspace_id, input["text"] as string);
    return { sent: true };
  }
  if (patchDigest === undefined) throw new Error("a pull request call has no patch in its approval subject");
  return { ...(await openPullRequest(gov, attempt, task, { project: input["project"] as string, title: input["title"] as string, body: input["body"] as string }, patchDigest)) };
}

const words = (e: unknown): string => {
  if (e instanceof ToolRefusal || e instanceof BrainError) return e.message;
  console.error(e);
  return "Brain could not carry out the call";
};
const inFlight = new Map<string, Promise<BrainToolResponse>>();

/** Runs a Brain-run tool for an attempt. Asking again with the same call id answers what the first call answered, or carries on once its approval is decided. */
export function runBrainTool(gov: Gov, attempt: AttemptRow, request: Omit<BrainToolRequest, "fence">): Promise<BrainToolResponse> {
  const { db } = gov;
  const task = taskOf(db, attempt.task_id);
  const manifest = manifestOf(gov, task.snapshot_digest);
  const tool = manifest.agents[attempt.agent]?.tools.includes(request.tool) ? manifest.tools[request.tool] : undefined;
  if (!tool || tool.runs !== "brain") throw new BrainError("FORBIDDEN", `The agent ${attempt.agent} has no tool ${request.tool} that Brain runs`);
  const rowId = callRowId(attempt, request.callId);
  const answered = (outcome: ToolOutcome, output: JsonValue): BrainToolResponse => {
    const error = (output as { error?: unknown } | null)?.error;
    if (outcome === "succeeded") return { state: "done", output };
    return outcome === "failed" ? { state: "failed", error: typeof error === "string" ? error : "The call failed" } : { state: "rejected", reason: typeof error === "string" ? error : "The call did not happen" };
  };
  const finish = (outcome: "succeeded" | "failed", output: JsonValue): BrainToolResponse => {
    finishCall(gov, rowId, outcome, output);
    return answered(outcome, output);
  };

  const run = async (): Promise<BrainToolResponse> => {
    const input = request.input as Input;
    const first = tx(db, (): BrainToolResponse | { patchDigest: Digest | undefined } => {
      const known = db.prepare("SELECT outcome, output_json, approval_id FROM tool_calls WHERE id=?").get(rowId) as { outcome: ToolOutcome | "pending"; output_json: string | null; approval_id: string | null } | undefined;
      // A call the Governor already carried out is answered as it was; a runner that reported the call as held has not been answered yet.
      if (known && known.outcome !== "pending" && known.outcome !== "held") return answered(known.outcome, JSON.parse(known.output_json ?? "null") as JsonValue);
      // Asked before: the approval stands for the input and the patch it was asked with.
      const asked = known !== undefined && known.approval_id !== null;
      try {
        const problem = asked ? undefined : inputProblem(tool.input_schema, request.input);
        if (problem) throw new ToolRefusal(`The input of ${request.tool} is not valid: ${problem}`);
        const decision = authorizeCall(gov, attempt, { callId: request.callId, tool: request.tool, effect: tool.effect, input: request.input, patchDigest: !asked && request.tool === "git.open-pr" ? pullRequestPatch(gov, attempt, task, input["project"] as string) : undefined });
        if (decision.state === "pending") return { state: "pending", approvalId: decision.approvalId as string };
        if (decision.state !== "approved") return { state: "rejected", reason: decision.reason ?? "The call was not approved" };
        if (request.tool === "git.open-pr" || request.tool === "message.send") return { patchDigest: decision.subject?.patchDigest };
        // In a transaction of its own inside this one: a tool that fails half-way leaves nothing behind.
        return finish("succeeded", tx(db, () => runNow(gov, attempt, task, request.tool, input)));
      } catch (e) {
        openCall(gov, attempt, request.callId, { tool: request.tool, effect: tool.effect, input: request.input });
        return finish("failed", { error: words(e) });
      }
    });
    if (!("patchDigest" in first)) return first;
    try {
      const output = await runOutside(gov, attempt, task, request.tool, input, first.patchDigest);
      return tx(db, () => finish("succeeded", output));
    } catch (e) {
      return tx(db, () => finish("failed", { error: words(e) }));
    }
  };
  // The same call asked twice at once is carried out once.
  const running = inFlight.get(rowId) ?? run().finally(() => inFlight.delete(rowId));
  inFlight.set(rowId, running);
  return running;
}
