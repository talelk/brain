import { sha256Digest } from "@brain/contracts";
import type { EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";

export const nativeToolName = (toolId: string) => `brain_${toolId.replace(/[^A-Za-z0-9_]/gu, "_")}`;

/**
 * What one tool answer may weigh in the model's context. The full answer is stored as the call's artifact and receipt; the model sees at most
 * this much of it, because every character is re-sent with every later turn of the attempt (a 40k answer read at turn 3 of 20 is paid 17 times).
 */
export const TOOL_RESULT_CHARS = 16_000;

/** The text a model is shown for a tool answer: as is when short, else its beginning and a plain note of what was left out. */
export function boundedToolText(output: JsonValue, limit: number = TOOL_RESULT_CHARS): string {
  const text = JSON.stringify(output) ?? "null";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[cut: the answer is ${text.length} characters long and only the first ${limit} are shown; ask for something narrower if the rest matters]`;
}

export interface ToolCallPolicy {
  /** Tool calls this session may make (the agent's turn limit); the next one is refused, not executed. */
  readonly maxCalls?: number;
  /** A reason to refuse every further call right now (the attempt's allowance is nearly used); the model is told to write its answer. */
  readonly refuse?: () => string | undefined;
  /** Identical read calls the model may repeat (each is told it already has the answer) before the session's tools are taken away. */
  readonly maxRepeats?: number;
  /** One line added to the answer of every executed call: how much of the attempt is used. */
  readonly note?: (callsUsed: number) => string | undefined;
  /** The session has used its calls or its repeat budget: the engine takes the tools away so the next turn can only be the answer. */
  readonly exhausted?: (why: string) => void;
}

export class GovernedToolCalls {
  private readonly bindings = new Map<string, EngineToolBinding>();
  private readonly pending = new Map<string, (result: EngineToolExecutionResult) => void>();
  /** Read calls already answered in this session, by tool and input digest: asking again is told so instead of paying for the same answer twice. */
  private readonly answered = new Set<string>();
  /** Every call the model asked for, refused or not: a refused or repeated call costs a whole model turn too, so the ceiling counts these. */
  private asked = 0;
  private repeats = 0;
  constructor(bindings: readonly EngineToolBinding[], private readonly spec: EngineSessionSpec, private readonly push: (kind: EngineEvent["kind"], payload: EngineEvent["payload"]) => void, private readonly policy: ToolCallPolicy = {}) {
    for (const binding of bindings) this.bindings.set(nativeToolName(binding.release.id), binding);
  }
  names(): string[] { return [...this.bindings.keys()]; }
  binding(name: string): EngineToolBinding {
    const binding = this.bindings.get(name);
    if (!binding || !this.spec.allowedTools.some((tool) => tool.id === binding.release.id && tool.digest === binding.release.digest)) throw new Error(`tool ${name} is not allowed by this Agent release`);
    return binding;
  }
  /**
   * One model tool call, answered with the text the model gets back. A refused call (allowance used, repeated call) is answered with a plain
   * instruction and never reaches the broker, so it is no call on record; an executed call's answer is cut to `TOOL_RESULT_CHARS`.
   */
  async execute(name: string, proposalId: string, input: JsonValue): Promise<string> {
    const binding = this.binding(name);
    const stop = this.policy.refuse?.();
    if (stop) return JSON.stringify({ refused: true, error: stop });
    const limit = this.policy.maxCalls;
    this.asked += 1;
    if (limit !== undefined && this.asked > limit) {
      return JSON.stringify({ refused: true, error: "The tool-call budget is used up. Stop calling tools now and write the answer from what you already have, saying what you could not check." });
    }
    if (this.pending.has(proposalId)) throw new Error("duplicate tool proposal identifier");
    const inputDigest = sha256Digest(new TextEncoder().encode(JSON.stringify(input)));
    const asked = `${name}:${inputDigest}`;
    if (binding.effectClass === "read" && this.answered.has(asked)) {
      this.repeats += 1;
      const spent = this.policy.maxRepeats !== undefined && this.repeats >= this.policy.maxRepeats;
      if (spent) this.policy.exhausted?.("You keep repeating a call you already have the answer to.");
      else if (limit !== undefined && this.asked >= limit) this.policy.exhausted?.("That was your last tool call.");
      return JSON.stringify({ refused: true, error: "You already have this: the same call was answered earlier in this conversation and nothing has changed. Do not call it again; write your answer now from that result." });
    }
    const result = new Promise<EngineToolExecutionResult>((resolve) => this.pending.set(proposalId, resolve));
    this.push("tool.proposed", { proposalId, tool: binding.release, input, target: binding.target, inputDigest });
    try {
      const completed = await result;
      this.push("tool.result", { proposalId, invocationId: completed.invocationId, receipt: completed.receipt });
      if (completed.receipt.result === "succeeded") this.answered.add(asked);
      if (limit !== undefined && this.asked >= limit) this.policy.exhausted?.("That was your last tool call.");
      const note = this.policy.note?.(this.asked);
      return `${boundedToolText(completed.output)}${note ? `\n[${note}]` : ""}`;
    } finally { this.pending.delete(proposalId); }
  }
  complete(result: EngineToolExecutionResult): void {
    const resolve = this.pending.get(result.proposalId);
    if (!resolve) throw new Error("tool result does not match a pending proposal");
    resolve(result);
  }
  clear(): void { this.pending.clear(); }
}
