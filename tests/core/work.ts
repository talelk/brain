import type { Clock, CommandOutputs, Task, TaskSummary } from "@brain/contracts";
import type { Reply } from "./driver";
import type { Client, Harness } from "./harness";

/** What the tests of the work side share: workspace folders written through `file.write`, a clock they move, and a few readers. */

const brainTool = (effect: string, inputs: Record<string, string>): string =>
  `description = "A tool Brain runs."\nruns = "brain"\neffect = "${effect}"\n${Object.entries(inputs).map(([name, spec]) => `[inputs.${name}]\n${spec}\n`).join("")}`;
const text = 'type = "string"\nrequired = true';
/** The Brain-run tools with the inputs packs/README.md gives them (`task.note` comes with the `core` fixture pack). */
export const BRAIN_TOOLS: Record<string, string> = {
  "task.create": brainTool("read", { title: text, goal: text, agent: text, after: 'type = "array"\nitems = { type = "string" }' }),
  "task.ask": brainTool("read", { question: text }),
  "memory.search": brainTool("read", { query: text, limit: 'type = "integer"' }),
  "memory.propose": brainTool("read", { name: text, title: text, text }),
  "git.open-pr": brainTool("write", { project: text, title: text, body: text }),
  "message.send": brainTool("write", { text }),
  "workspace.fix": brainTool("write", { task: 'type = "string"', files: 'type = "array"\nitems = { type = "object" }\nrequired = true', message: text, why: text }),
};

export interface WorkspaceFiles {
  /** Lines of brain.toml after `name` and `packs`. */
  readonly brain?: string;
  readonly packs?: readonly string[];
  /** Makes it a platform workspace of this kind (the instance admin creates it). */
  readonly platform?: "admin" | "read";
  /** Agents by name: the tools each may use and the level of native tools. Each runs on the fixture engine. */
  readonly agents?: Record<string, { tools?: readonly string[]; native?: "none" | "read" | "all"; spend?: number; uncapped?: boolean }>;
  /** Plays by name, as TOML. */
  readonly plays?: Record<string, string>;
  /** Other tools by name, as the TOML of `tool.toml`; a tool that is not Brain-run gets a `run.sh`. */
  readonly tools?: Record<string, string>;
  readonly memory?: Record<string, string>;
}
/** Creates a workspace from the `core` fixture pack and writes the given agents, tools, Plays and memory into its folder. */
export async function makeWorkspace(harness: Harness, name: string, files: WorkspaceFiles = {}): Promise<CommandOutputs["workspace.create"]> {
  const packs = files.packs ?? ["core"];
  const made = await harness.createWorkspace({ name, packs: [...packs], ...(files.platform ? { platform: files.platform } : {}) });
  const used = new Set(Object.values(files.agents ?? {}).flatMap((agent) => agent.tools ?? []));
  const tools = { ...Object.fromEntries(Object.entries(BRAIN_TOOLS).filter(([tool]) => used.has(tool))), ...files.tools };
  // A folder that does not validate is the test's own mistake: say which file and why.
  const explain = (e: { message: string; problems?: ReadonlyArray<{ path: string; message: string }> }): never => { throw new Error(`${e.message}: ${(e.problems ?? []).map((problem) => `${problem.path}: ${problem.message}`).join("; ")}`); };
  await harness.admin.command("file.write", {
    workspaceId: made.workspaceId,
    files: [
      { path: "brain.toml", content: `name = "${name}"\n${files.platform ? `platform = "${files.platform}"\n` : ""}packs = ${JSON.stringify(packs)}\n${files.brain ?? ""}\n` },
      ...Object.entries(files.agents ?? {}).flatMap(([agent, spec]) => [
        { path: `agents/${agent}/agent.toml`, content: `description = "The ${agent}."\nengine = ["fixture"]\nnative = "${spec.native ?? "none"}"\ntools = ${JSON.stringify(spec.tools ?? [])}\n[limits]\n${spec.uncapped ? "turns = 0\ntokens = 0\n" : ""}spend_usd = ${spec.spend ?? 0}\n` },
        { path: `agents/${agent}/prompt.md`, content: `You are the ${agent}.\n` },
      ]),
      ...Object.entries(tools).flatMap(([tool, toml]) => [{ path: `tools/${tool}/tool.toml`, content: toml }, ...(/runs = "brain"|host_command/u.test(toml) ? [] : [{ path: `tools/${tool}/run.sh`, content: "#!/bin/sh\ncat\n" }])]),
      ...Object.entries(files.plays ?? {}).map(([play, toml]) => ({ path: `plays/${play}.toml`, content: toml })),
      ...Object.entries(files.memory ?? {}).map(([entry, markdown]) => ({ path: `memory/${entry}.md`, content: markdown })),
    ],
  }).catch(explain);
  return made;
}

/** A clock a test moves by hand. */
export function testClock(start = Date.UTC(2026, 10, 16, 9, 0, 0)): Clock & { now: number; advance(ms: number): void } {
  const clock = { now: start, nowMs: () => clock.now, monotonicMs: () => clock.now, advance: (ms: number) => void (clock.now += ms) };
  return clock;
}

/** What a checker answers. */
export const pass = (findings = "Every part of the goal is met.", score = 0.9): Reply => ({ output: { pass: true, score, findings } });
export const fail = (findings: string, score = 0.3): Reply => ({ output: { pass: false, score, findings } });

export const getTask = (client: Client, workspaceId: string, taskId: string): Promise<Task> => client.query("task.get", { workspaceId, taskId });
/** The sub-task made from a step (the first, when a `for_each` made several). */
export function step(task: Task, stepId: string): TaskSummary {
  const found = task.subtasks.find((subtask) => subtask.stepId === stepId && subtask.parentId === task.id);
  if (!found) throw new Error(`the task has no step ${stepId}`);
  return found;
}
/** The states of a task's steps, by step id. */
export const states = (task: Task): Record<string, string> => Object.fromEntries(task.subtasks.filter((subtask) => subtask.parentId === task.id).map((subtask) => [subtask.stepId ?? subtask.title, subtask.state]));
