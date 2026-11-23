import { commands, queries, type CommandType, type QueryType } from "@brain/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BrainClient, BrainRequestError, type BrainConfig } from "./client";
import { compact, compactText } from "./compact";

/** What the model is told when it connects: the product in a paragraph, and the safe way to change it. */
export const INSTRUCTIONS = `Brain runs agents on work. A workspace is a folder of plain files: brain.toml (settings), agents/<name>/agent.toml (+ prompt), tools/<name>/tool.toml, plays/<name>.toml (a Play is a named recipe of steps run by agents), memory and packs (shared bundles of the same files, hiding or extended by workspace files). A project is a git repository agents work on. A task is one unit of work: a goal (root task) is planned into sub-tasks, each run in attempts by an agent, then checked by another agent or a person; states are waiting, ready, running, needs_you, done, failed, stopped. Ids: pass workspaceId exactly as brain_workspaces shows it.

Plan work: brain_task_create with a goal (free text) or a play name plus inputs; follow it with brain_task_get and brain_task_events; steer, stop, retry, answer a question (needs.kind=answer) or record a check.

Optimise Brain safely: (1) brain_insights and brain_tasks_list (state=failed, needs_you) to find waste, repeated work, failures and cost; (2) brain_task_get / brain_task_events on the worst ones to learn why; (3) brain_file_read the agent, tool or Play behind it; (4) brain_file_write a small change (one commit; Brain refuses an invalid folder and writes nothing); (5) verify by running a task (brain_task_create) and checking its result and cost; revert with another brain_file_write if worse. Approvals and memory proposals are human gates and are not available here. Long text and lists in answers are truncated and say so; narrow with limits and filters.`;

type Kind = "query" | "command";
interface ToolSpec {
  readonly name: string;
  readonly kind: Kind;
  readonly type: QueryType | CommandType;
  readonly description: string;
  readonly title: string;
  /** A narrower input than the contract's, when part of it must not be offered here. */
  readonly shape?: z.ZodRawShape;
  readonly format?: (output: unknown) => string;
}

const read = (name: string, type: QueryType, description: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({ name, kind: "query", type, description, title: name, ...extra });
const write = (name: string, type: CommandType, description: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({ name, kind: "command", type, description, title: name, ...extra });

const fileText = (output: unknown): string => {
  const file = output as { content?: unknown; binary?: boolean };
  if (file.binary === true || typeof file.content !== "string") return compact({ ...file, content: undefined });
  return `${compact({ ...file, content: undefined })}\n---\n${compactText(file.content)}`;
};

const rawShape = (type: QueryType | CommandType, kind: Kind): z.ZodRawShape => ((kind === "query" ? queries : commands) as Record<string, { input: { shape: z.ZodRawShape } }>)[type]!.input.shape;
const omit = (shape: z.ZodRawShape, ...names: string[]): z.ZodRawShape => Object.fromEntries(Object.entries(shape).filter(([key]) => !names.includes(key)));

export const READ_TOOLS: readonly ToolSpec[] = [
  read("brain_overview", "overview", "What every workspace you can see is doing now: counts of tasks by state, what needs you, recent events. Start here."),
  read("brain_queue", "queue", "Runners, their slots and the waiting list in dispatch order, for all workspaces or one."),
  read("brain_insights", "insights", "What happened over the last 7, 30 or 90 days: outcomes per day, durations, queue wait, failure reasons, repeated work, cost. The main input to optimising."),
  read("brain_workspaces", "me", "Who you are signed in as and the workspaces you can reach (id, slug, name, role). Use the id as workspaceId."),
  read("brain_workspace_files", "workspace.files", "Every file of a workspace folder and its packs (path, size, source, last commit), without content."),
  read("brain_file_read", "file.read", "The text of one file of a workspace (agent.toml, a prompt, a Play, brain.toml, memory). Long files are truncated.", { format: fileText }),
  read("brain_tasks_list", "tasks.list", "Tasks of a workspace, newest first, filtered by state, parent, text search or rootsOnly. Use state=failed or needs_you to find trouble."),
  read("brain_task_get", "task.get", "One task in full: goal, plan with sub-tasks, attempts (agent, model, result, failure, cost), checks and what it waits for."),
  read("brain_task_events", "task.events", "The events of one attempt (messages, tool calls, results) after a position; use it to see why an attempt failed or was slow."),
  read("brain_packs_list", "packs.list", "The packs of the platform workspace with their released versions (instance admin)."),
  read("brain_audit_verify", "audit.verify", "Checks the audit chain end to end and says whether it is intact (instance admin)."),
  read("brain_schedules_list", "schedules.list", "Every scheduled or webhook Play of the visible workspaces with its next and last run."),
];

export const WRITE_TOOLS: readonly ToolSpec[] = [
  write("brain_task_create", "task.create", "Starts work: a goal in words, or a Play with its inputs. Returns the task id; follow it with brain_task_get."),
  write("brain_task_steer", "task.steer", "Sets a task's priority and/or whether it is paused."),
  write("brain_task_stop", "task.stop", "Stops a task and what is running for it."),
  write("brain_task_retry", "task.retry", "Runs a failed or stopped task again."),
  write("brain_task_check", "task.check", "Records a person's check: pass or fail with findings (a fail sends the work back for another round)."),
  write("brain_task_answer", "task.answer", "Answers the question a task asks (needs.kind=answer)."),
  write("brain_task_checkpoint", "task.checkpoint", "Answers a checkpoint of a long goal: continue as is, or with a changed goal."),
  write("brain_file_write", "file.write", "Writes files of a workspace folder in one commit (agents, tools, Plays, memory, brain.toml) and removes the paths of `remove` (a rename). Refused, and nothing written, when the folder would not be valid; the problems say which file and why. Read the file first and change as little as possible."),
  write("brain_file_delete", "file.delete", "Deletes files of a workspace folder in one commit."),
  write("brain_pack_release", "pack.release", "Releases a pack of the platform workspace: its version goes up by one and that content is frozen."),
  write("brain_workspace_create", "workspace.create", "Makes a workspace (instance admin), optionally from packs. Models and projects with credentials are set in the web app.", { shape: omit(rawShape("workspace.create", "command"), "model", "project") }),
  write("brain_workspace_archive", "workspace.archive", "Archives a workspace."),
];

const failure = (error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } => {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof BrainRequestError) {
    const { code, problems } = error.error;
    text = `${code ?? `HTTP ${error.status}`}: ${error.message}`;
    if (problems !== undefined && problems.length > 0) text += `\n${problems.slice(0, 20).map((problem) => `- ${problem.path}: ${problem.message}`).join("\n")}`;
  }
  return { content: [{ type: "text", text }], isError: true };
};

/** The tools served: only the reads when `readonly`. Each takes the contract's own input and sends it as that command or query. */
export const createServer = (config: BrainConfig, readonly = false): McpServer => {
  const client = new BrainClient(config);
  const server = new McpServer({ name: "brain", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const spec of readonly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]) {
    const isQuery = spec.kind === "query";
    const contract = (isQuery ? queries : commands)[spec.type as never] as { input: z.ZodType };
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.shape ?? rawShape(spec.type, spec.kind),
      annotations: isQuery ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: spec.name === "brain_file_delete" || spec.name === "brain_workspace_archive" || spec.name === "brain_task_stop", openWorldHint: false },
    }, async (args: Record<string, unknown>) => {
      try {
        const input = contract.input.parse(args);
        const output = await (isQuery ? client.query(spec.type, input) : client.command(spec.type, input));
        const text = spec.format?.(output) ?? (isQuery ? compact(output) : `ok ${compact(output)}`);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
};
