import type { JobOffer, JsonValue, OfferToolCall } from "@brain/contracts";

/**
 * The task text of an attempt: everything of the offer the agent is to know, in one text with the same headings every time. The agent's
 * prompt says who it is and how to work; this says what the work is. The first line names the attempt's kind and round.
 */

/** Where the attempt's folders are, as the engine sees them; `work` is absent when the engine sees no working copy. */
export interface AttemptPaths { readonly work?: string; readonly out: string; /** The read-only copy of the workspace's own definition, when the agent is given it. */ readonly workspace?: string }

/** What a review entry's patch became for this attempt: a file the agent can read, or (when it can read no files) the start of its text. */
export interface ReviewPatch { readonly path?: string; readonly inline?: string }

/** The final-answer formats of the kinds that must end with JSON (packs/README.md). The judge's is defined here: no prompt of the packs states it. */
export const PLAN_SHAPE = '{"summary": "string", "tasks": [{"title": "string", "goal": "string", "agent": "string", "after": ["title of an earlier task"]}]}';
export const CHECK_SHAPE = '{"pass": true, "score": 0.9, "findings": "string"}';
export const JUDGE_SHAPE = '{"keep": "<the attempt id of the one candidate to keep>", "findings": "string"}';

const RESULT_CHARS = 12_000;
const CALL_CHARS = 2_000;
const MAX_CALLS = 60;

const cut = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}\n[cut: ${text.length} characters in all]`);
const compact = (value: JsonValue, limit: number): string => cut(typeof value === "string" ? value : JSON.stringify(value) ?? "null", limit);
const listed = (entries: ReadonlyArray<{ readonly name: string; readonly description: string; readonly tools?: ReadonlyArray<string>; readonly writes?: boolean }>): string =>
  entries.map((entry) => `- ${entry.name}${entry.tools && entry.tools.length > 0 || entry.writes ? ` (${[...(entry.tools && entry.tools.length > 0 ? [`tools: ${entry.tools.join(", ")}`] : []), ...(entry.writes ? ["can write files"] : [])].join("; ")})` : ""}: ${entry.description.replace(/\s+/gu, " ").trim()}`).join("\n");

function toolCalls(calls: readonly OfferToolCall[]): string {
  if (calls.length === 0) return "No tool calls were recorded.";
  const shown = calls.slice(0, MAX_CALLS).map((call, index) => `${index + 1}. ${call.tool} (${call.effect}, ${call.outcome})\n   input: ${compact(call.input, CALL_CHARS)}\n   output: ${compact(call.output, CALL_CHARS)}`);
  return `${shown.join("\n")}${calls.length > MAX_CALLS ? `\n[${calls.length - MAX_CALLS} more calls are not shown]` : ""}`;
}

/**
 * Where the agent is, and what is kept: only the project folders under `/work` (as changes) and the files in `/out` (as results) outlive the attempt,
 * and a reviewer sees nothing else. A file written anywhere else, `/work` itself included, is lost with the attempt's sandbox.
 */
function environment(paths: AttemptPaths, projects: number): string {
  const work = paths.work
    ? projects > 0 ? `${paths.work}/<project> are the project folders; changes to them are kept and shown to the reviewer.` : `${paths.work} is empty: this task has no project folder, and a file written there is lost when the attempt ends.`
    : "There is no working copy for this task.";
  const own = paths.workspace ? ` ${paths.workspace} is a read-only copy of this workspace's own definition (manifest.json with every agent, tool, Play, limit and project; agents/<name>/prompt.md; tools/<name>/; memory/; docs); read it for questions about the workspace's files; nothing written there is kept.` : "";
  return `# Where you are\n${work}${own} ${paths.out} is where every file to keep as a result goes (a report, a plan, a list); the reviewer and the person read it from there. The task text above and your tools hold everything else you need. Do not search or list the rest of the file system (\`/\`, \`/state\`, \`/app\`): it holds nothing of this task and only fills your context. Brain checks the files your answer says you saved: never claim work you did not do. If you cannot do this task with the tools and folders you have, start your answer with \`BLOCKED:\` and the reason; that is a valid answer, and it goes back to be fixed.`;
}

export function composeTask(offer: JobOffer, paths: AttemptPaths, patches: ReadonlyMap<string, ReviewPatch> = new Map(), files?: ReadonlyMap<string, ReviewPatch>): string {
  const { task, context, kind } = offer;
  const parts: string[] = [`[${kind} attempt, round ${task.round}]`, `# Goal\n${task.title}\n\n${task.goal}`];
  if (task.findings.length > 0) parts.push(`# Findings of earlier rounds\nThis is round ${task.round}. Earlier checks of this task found the following; each point must be dealt with.\n${task.findings.map((finding, index) => `${index + 1}. ${finding}`).join("\n")}`);
  if (context.results.length > 0) parts.push(`# Results of the tasks this one waits for\n${context.results.map((entry) => `## ${entry.title} (task ${entry.taskId})\n${cut(entry.result, RESULT_CHARS)}`).join("\n\n")}`);
  if (context.notes.length > 0) parts.push(`# Shared notes\n${context.notes.map((note) => `- ${note.author}: ${note.text}`).join("\n")}`);
  if (context.answers.length > 0) parts.push(`# Answers to earlier questions\n${context.answers.map((entry) => `- Question: ${entry.question}\n  Answer (${entry.by}): ${entry.answer}`).join("\n")}`);
  const { agents, tools, plays } = context.catalog;
  if (agents.length + tools.length + plays.length > 0) {
    parts.push(["# This workspace", agents.length > 0 ? `## Agents\n${listed(agents)}` : "", tools.length > 0 ? `## Tools\n${listed(tools)}` : "", plays.length > 0 ? `## Plays\n${listed(plays)}` : ""].filter(Boolean).join("\n"));
  }
  if (context.review && context.review.length > 0) {
    const candidate = kind === "judge";
    parts.push(`# ${candidate ? "The candidates" : "What to check"}\n${context.review.map((entry) => {
      const patch = patches.get(entry.attemptId);
      const diff = patch?.path ? `The changes to the working copy are in the patch file ${patch.path}; read it.` : patch?.inline ? `The changes to the working copy:\n${patch.inline}` : "The working copy was not changed.";
      const kept = entry.files.length === 0 ? "" : `\n### Files kept as results\n${entry.files.map((file) => { const shown = files?.get(`${entry.attemptId}/${file.name}`); return `- ${file.name} (${file.bytes} bytes)${shown?.path ? `: read it at ${shown.path}` : shown?.inline ? `:\n${shown.inline}` : ""}`; }).join("\n")}`;
      return `## ${candidate ? "Candidate" : "Result"} ${entry.attemptId} (by agent ${entry.agent})\n### Result\n${cut(entry.result, RESULT_CHARS)}\n### Recorded tool calls\n${toolCalls(entry.toolCalls)}\n### Changes\n${diff}${kept}`;
    }).join("\n\n")}`);
  }
  parts.push(environment(paths, offer.projects.length));
  if (offer.projects.length > 0 && paths.work) parts.push(`# Working copy\n${offer.projects.map((project) => `- ${project.name}: ${paths.work}/${project.name} (branch ${project.branch})`).join("\n")}\nFiles to keep as results go in ${paths.out}.`);
  if (kind === "judge") parts.push(`# Final answer\nKeep exactly one candidate. Reply with one JSON object and nothing else:\n${JUDGE_SHAPE}`);
  return parts.join("\n\n");
}
