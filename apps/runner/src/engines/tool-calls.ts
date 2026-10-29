import { sha256Digest } from "@brain/contracts";
import type { EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";

export const nativeToolName = (toolId: string) => `brain_${toolId.replace(/[^A-Za-z0-9_]/gu, "_")}`;

export class GovernedToolCalls {
  private readonly bindings = new Map<string, EngineToolBinding>();
  private readonly pending = new Map<string, (result: EngineToolExecutionResult) => void>();
  constructor(bindings: readonly EngineToolBinding[], private readonly spec: EngineSessionSpec, private readonly push: (kind: EngineEvent["kind"], payload: EngineEvent["payload"]) => void) {
    for (const binding of bindings) this.bindings.set(nativeToolName(binding.release.id), binding);
  }
  names(): string[] { return [...this.bindings.keys()]; }
  binding(name: string): EngineToolBinding {
    const binding = this.bindings.get(name);
    if (!binding || !this.spec.allowedTools.some((tool) => tool.id === binding.release.id && tool.digest === binding.release.digest)) throw new Error(`tool ${name} is not allowed by this Agent release`);
    return binding;
  }
  async execute(name: string, proposalId: string, input: JsonValue): Promise<JsonValue> {
    const binding = this.binding(name);
    if (this.pending.has(proposalId)) throw new Error("duplicate tool proposal identifier");
    const inputDigest = sha256Digest(new TextEncoder().encode(JSON.stringify(input)));
    const result = new Promise<EngineToolExecutionResult>((resolve) => this.pending.set(proposalId, resolve));
    this.push("tool.proposed", { proposalId, tool: binding.release, input, target: binding.target, inputDigest });
    try {
      const completed = await result;
      this.push("tool.result", { proposalId, invocationId: completed.invocationId, receipt: completed.receipt });
      return completed.output;
    } finally { this.pending.delete(proposalId); }
  }
  complete(result: EngineToolExecutionResult): void {
    const resolve = this.pending.get(result.proposalId);
    if (!resolve) throw new Error("tool result does not match a pending proposal");
    resolve(result);
  }
  clear(): void { this.pending.clear(); }
}
