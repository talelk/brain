import type { JsonValue } from "@brain/contracts";
import type { EngineEvent, EngineTool } from "./port";

/** Names an engine's own tools may have; a workspace tool that would be called the same gets a prefix. */
const NATIVE_NAMES = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "glob", "shell", "patch"]);

/**
 * What the model calls a workspace tool. Model APIs take letters, digits, `_` and `-` only, so the dots of a tool name become
 * underscores (`git.open-pr` is `git_open-pr`); the description starts with the real name, which is the one prompts use.
 */
export function engineToolName(name: string): string {
  const plain = name.replace(/\./gu, "_");
  return NATIVE_NAMES.has(plain.toLowerCase()) ? `tool_${plain}` : plain;
}

export const engineToolDescription = (tool: EngineTool): string => `[${tool.name}] ${tool.description}`.trim();

/**
 * What one tool answer may weigh in the model's context. The whole answer is in the attempt's events; the model sees at most this much,
 * because every character is sent again with every later turn of the attempt.
 */
export const TOOL_RESULT_CHARS = 16_000;

/** The text a model is shown for a tool answer: as it is when short, else its beginning and a plain note of what was left out. */
export function boundedToolText(output: JsonValue, limit: number = TOOL_RESULT_CHARS): string {
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "null";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[cut: the answer is ${text.length} characters long and only the first ${limit} are shown; ask for something narrower if the rest matters]`;
}

export interface ToolRequestPolicy {
  /** Calls a session may make; the next one is refused, not carried out. */
  readonly maxCalls?: number;
  /** A reason to refuse every further call right now (the attempt's allowance is nearly used); the model is told to write its answer. */
  readonly refuse?: () => string | undefined;
}

/**
 * The workspace-tool calls of one engine session. A call the model makes becomes a `tool.request` event; the runner carries it out
 * (validation, approval, sandbox) and answers through `complete`, and the model gets that text. A refused call never leaves the engine.
 */
export class ToolRequests {
  private readonly tools = new Map<string, EngineTool>();
  private readonly pending = new Map<string, (text: string) => void>();
  private asked = 0;

  constructor(tools: readonly EngineTool[], private readonly push: (event: EngineEvent) => void, private readonly policy: ToolRequestPolicy = {}) {
    for (const tool of tools) this.tools.set(engineToolName(tool.name), tool);
  }

  /** The tools by the name the model calls them. */
  entries(): Array<readonly [string, EngineTool]> { return [...this.tools]; }
  names(): string[] { return [...this.tools.keys()]; }
  has(engineName: string): boolean { return this.tools.has(engineName); }

  async execute(engineName: string, input: JsonValue): Promise<string> {
    const tool = this.tools.get(engineName);
    if (!tool) return JSON.stringify({ refused: true, error: `There is no tool ${engineName} in this task.` });
    const stop = this.policy.refuse?.();
    if (stop) return JSON.stringify({ refused: true, error: stop });
    this.asked += 1;
    if (this.policy.maxCalls !== undefined && this.asked > this.policy.maxCalls) {
      return JSON.stringify({ refused: true, error: "The tool-call budget is used up. Stop calling tools now and write the answer from what you already have, saying what you could not check." });
    }
    const callId = `request-${this.asked}`;
    const answered = new Promise<string>((resolve) => this.pending.set(callId, resolve));
    this.push({ kind: "tool.request", callId, tool: tool.name, input });
    try { return await answered; } finally { this.pending.delete(callId); }
  }

  complete(callId: string, text: string): void {
    const resolve = this.pending.get(callId);
    if (!resolve) throw new Error("the tool result does not match a pending request");
    resolve(text);
  }

  /** The session is ending: a call still waiting is answered so nothing hangs on it. */
  clear(): void {
    for (const resolve of this.pending.values()) resolve(JSON.stringify({ refused: true, error: "The session ended before this call was answered." }));
    this.pending.clear();
  }
}
