import type { JobOffer, JsonValue, OfferToolCall } from "@brain/contracts";

/**
 * The task text of an attempt: everything of the offer the agent is to know, in one text with the same headings every time. The agent's
 * prompt says who it is and how to work; this says what the work is. The first line names the attempt's kind and round.
 */

/** Where the attempt's folders are, as the engine sees them; `work` is absent when the engine sees no working copy. */
export interface AttemptPaths { readonly work?: string; readonly out: string }

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
const listed = (entries: ReadonlyArray<{ readonly name: string; readonly description: string; readonly tools?: ReadonlyArray<string> }>): string =>
  entries.map((entry) => `- ${entry.name}${entry.tools && entry.tools.length > 0 ? ` (tools: ${entry.tools.join(", ")})` : ""}: ${entry.description.replace(/\s+/gu, " ").trim()}`).join("\n");

function toolCalls(calls: readonly OfferToolCall[]): string {
  if (calls.length === 0) return "No tool calls were recorded.";
  const shown = calls.slice(0, MAX_CALLS).map((call, index) => `${index + 1}. ${call.tool} (${call.effect}, ${call.outcome})\n   input: ${compact(call.input, CALL_CHARS)}\n   output: ${compact(call.output, CALL_CHARS)}`);
  return `${shown.join("\n")}${calls.length > MAX_CALLS ? `\n[${calls.length - MAX_CALLS} more calls are not shown]` : ""}`;
}

/** Where the agent is: so it does not search the machine for its files (the model's window is spent on listings of `/`). */
function environment(paths: AttemptPaths): string {
  const work = paths.work ? `${paths.work} is the working copy (the project folders)` : "there is no working copy: this attempt has no project folder";
  return `# Where you are\n${work}; ${paths.out} is where files to keep as results go. The task text above and your tools hold everything you need. Do not search or list the rest of the file system (\`/\`, \`/state\`, \`/app\`): it holds nothing of this task and only fills your context.`;
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
  parts.push(environment(paths));
  if (offer.projects.length > 0 && paths.work) parts.push(`# Working copy\n${offer.projects.map((project) => `- ${project.name}: ${paths.work}/${project.name} (branch ${project.branch})`).join("\n")}\nFiles to keep as results go in ${paths.out}.`);
  if (kind === "judge") parts.push(`# Final answer\nKeep exactly one candidate. Reply with one JSON object and nothing else:\n${JUDGE_SHAPE}`);
  return parts.join("\n\n");
}
