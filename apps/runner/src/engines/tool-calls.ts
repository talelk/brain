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
}

export class GovernedToolCalls {
  private readonly bindings = new Map<string, EngineToolBinding>();
  private readonly pending = new Map<string, (result: EngineToolExecutionResult) => void>();
  /** Read calls already answered in this session, by tool and input digest: asking again is told so instead of paying for the same answer twice. */
  private readonly answered = new Set<string>();
  private calls = 0;
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
    if (this.policy.maxCalls !== undefined && this.calls >= this.policy.maxCalls) {
      return JSON.stringify({ refused: true, error: "The tool-call budget is used up. Stop calling tools now and write the answer from what you already have, saying what you could not check." });
    }
    if (this.pending.has(proposalId)) throw new Error("duplicate tool proposal identifier");
    const inputDigest = sha256Digest(new TextEncoder().encode(JSON.stringify(input)));
    const asked = `${name}:${inputDigest}`;
    if (binding.effectClass === "read" && this.answered.has(asked)) {
      return JSON.stringify({ refused: true, error: "You already made this exact call and its answer is earlier in this conversation. Use that answer instead of asking again." });
    }
    this.calls += 1;
    const result = new Promise<EngineToolExecutionResult>((resolve) => this.pending.set(proposalId, resolve));
    this.push("tool.proposed", { proposalId, tool: binding.release, input, target: binding.target, inputDigest });
    try {
      const completed = await result;
      this.push("tool.result", { proposalId, invocationId: completed.invocationId, receipt: completed.receipt });
      if (completed.receipt.result === "succeeded") this.answered.add(asked);
      return boundedToolText(completed.output);
    } finally { this.pending.delete(proposalId); }
  }
  complete(result: EngineToolExecutionResult): void {
    const resolve = this.pending.get(result.proposalId);
    if (!resolve) throw new Error("tool result does not match a pending proposal");
    resolve(result);
  }
  clear(): void { this.pending.clear(); }
}
