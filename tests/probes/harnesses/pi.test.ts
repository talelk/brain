import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODEL_URL = process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1";
const MODEL_ID = process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b";

// G05 Pi probe against the local OpenAI-compatible vLLM endpoint.
// Skipped automatically when the endpoint is unreachable.
describe("G05 pi harness, same synthetic task as Muse (E062)", () => {
  it("starts a session, completes an exact prompt, disposes", async () => {
    let reachable = false;
    try {
      const res = await fetch(`${MODEL_URL}/models`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch { reachable = false; }
    if (!reachable) {
      console.warn(`local model endpoint unreachable at ${MODEL_URL}; Pi probe skipped`);
      return;
    }
    const agentDir = mkdtempSync(join(tmpdir(), "brain-pi-"));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "local-qwen": {
          name: "Local Qwen (vLLM)",
          baseUrl: MODEL_URL,
          api: "openai-completions",
          apiKey: "local-no-key",
          models: [{
            id: MODEL_ID, name: MODEL_ID, reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144, maxTokens: 4096,
          }],
        },
      },
    }, null, 2));
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const { createAgentSession, ModelRuntime } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("local-qwen" as never, MODEL_ID as never);
    expect(model, "custom local model must resolve from models.json").toBeTruthy();
    const { session } = await createAgentSession({ model, thinkingLevel: "low", modelRuntime: runtime, cwd: agentDir } as never);
    let text = "";
    try {
      session.subscribe((event: { type: string; assistantMessageEvent?: { type: string; delta?: string } }) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          text += event.assistantMessageEvent.delta ?? "";
        }
      });
      await session.prompt("Reply with exactly: BRAIN_OK");
    } finally {
      session.dispose();
    }
    expect(text).toContain("BRAIN_OK");
  }, 180_000);
});
