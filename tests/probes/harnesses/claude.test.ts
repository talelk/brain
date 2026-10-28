import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = process.env["BRAIN_ANTHROPIC_BASE_URL"] ?? "http://tntungx10:8000";
const MODEL = process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b";

// G05 Claude Agent SDK probe against the local Anthropic-compatible vLLM
// endpoint (per user direction: use the local model with Muse).
// Skips cleanly when the endpoint is unreachable. This proves SDK transport
// and one-shot completion, not the full harness conformance matrix.
describe("G05 claude Agent SDK, same synthetic task as Pi (E062)", () => {
  it("completes an exact one-shot prompt via the SDK", async () => {
    let reachable = false;
    try {
      const res = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch { reachable = false; }
    if (!reachable) {
      console.warn(`Anthropic endpoint unreachable at ${BASE}; Muse probe skipped`);
      return;
    }
    process.env["ANTHROPIC_BASE_URL"] = BASE;
    process.env["ANTHROPIC_API_KEY"] = "local-no-key";
    const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as typeof import("@anthropic-ai/claude-agent-sdk");
    const cwd = mkdtempSync(join(tmpdir(), "brain-claude-"));
    let text = "";
    for await (const message of query({
      prompt: "Reply with exactly: BRAIN_OK",
      options: { model: MODEL, cwd, maxTurns: 1, allowedTools: [] } as never,
    })) {
      const m = message as unknown as { type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string };
      if (m.type === "assistant") {
        for (const block of m.message?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
        }
      }
      if (m.type === "result" && typeof m.result === "string") text += m.result;
    }
    expect(text).toContain("BRAIN_OK");
  }, 240_000);
});
