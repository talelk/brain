import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeLevel } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeEngine } from "../../apps/runner/src/engines/opencode";
import type { EngineEvent, EngineSessionSpec } from "../../apps/runner/src/engines/port";
import { pickEngine } from "../../apps/runner/src/attempt";
import { tempDir } from "./git-repo";

/** The ACP adapter against a scripted stand-in for the agent (fake-acp-agent.mjs), which speaks what OpenCode 2.2.5 was seen to speak. */
const AGENT = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));
afterEach(() => { delete process.env["BRAIN_OPENCODE_COMMAND"]; });

async function run(native: NativeLevel, steps: unknown[], commandEnv?: Record<string, string>): Promise<{ events: EngineEvent[]; requests: Array<[string, unknown]> }> {
  const dir = tempDir("acp");
  writeFileSync(join(dir, "script.json"), JSON.stringify(steps));
  process.env["BRAIN_OPENCODE_COMMAND"] = `${process.execPath} ${AGENT} ${join(dir, "script.json")}`;
  const engine = new OpenCodeEngine();
  const spec: EngineSessionSpec = {
    attemptId: "a1", instructions: "You are a test agent.", task: "Do the scripted work.", model: { baseUrl: "http://127.0.0.1:1/v1", token: "attempt-token", name: "main" }, native, workDir: dir, outDir: dir, stateDir: dir, ...(commandEnv ? { commandEnv } : {}),
    tools: [{ name: "task.note", description: "Writes a note.", inputSchema: { type: "object" }, effect: "read" }], limits: { timeoutMs: 20_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 20 },
  };
  const signal = new AbortController().signal;
  const events: EngineEvent[] = [];
  const requests: Array<[string, unknown]> = [];
  await engine.start(spec, signal);
  for await (const event of engine.events(signal)) {
    events.push(event);
    if (event.kind === "tool.request") { requests.push([event.tool, event.input]); await engine.toolResult(event.callId, '{"id":"note-1"}'); }
  }
  await engine.dispose();
  return { events, requests };
}

const WRITE = { name: "write", kind: "edit", input: { path: "a.md", content: "hello" }, output: "Created file successfully: a.md" };

describe("the ACP adapter", () => {
  it("reports the agent's own tools as native calls and carries workspace tools over the MCP bridge", async () => {
    const ran = await run("all", [{ say: "I will write the file." }, { own: WRITE }, { mcp: { tool: "task_note", input: { text: "wrote it" } } }, { say: "Wrote a.md." }]);
    expect(ran.events.filter((event) => event.kind === "native.call" || event.kind === "native.result")).toEqual([
      { kind: "native.call", callId: "call_2", name: "write", input: { path: "a.md", content: "hello" } },
      { kind: "native.result", callId: "call_2", ok: true, output: "Created file successfully: a.md" },
      // The tool that carries a workspace call is the agent's own too, and is on the record with what it ran.
      { kind: "native.call", callId: "call_3", name: "execute", input: { code: "tools.brain.task_note(...)" } },
      { kind: "native.result", callId: "call_3", ok: true, output: '{"id":"note-1"}' },
    ]);
    expect(ran.requests).toEqual([["task.note", { text: "wrote it" }]]);
    // What the agent said before a tool call is narration; its answer is what follows the last one.
    expect(ran.events.filter((event) => event.kind === "text").map((event) => [event.channel, event.text])).toEqual([["diagnostic", "I will write the file."], ["assistant", "Wrote a.md."]]);
    expect(ran.events.slice(-3)).toEqual([{ kind: "usage", inputTokens: 300, outputTokens: 60, cachedInputTokens: 0, microUsd: 0, turns: 3 }, { kind: "text", channel: "assistant", text: "Wrote a.md." }, { kind: "stopped", reason: "completed" }]);
  });

  it("starts the agent, whose commands inherit its environment, with the variables of the session", async () => {
    const ran = await run("all", [{ env: "BRAIN_MODEL_TOKEN" }], { BRAIN_MODEL_TOKEN: "attempt-token" });
    expect(ran.events.filter((event) => event.kind === "text" && event.channel === "assistant")).toEqual([{ kind: "text", channel: "assistant", text: "attempt-token" }]);
  });

  it("refuses a permission request for a tool the native level does not include, and lets the session go on", async () => {
    const ran = await run("read", [{ own: { ...WRITE, ask: true } }, { own: { name: "read", kind: "read", input: { path: "a.md" }, output: "hello", ask: true } }, { say: "I could only read." }]);
    expect(ran.events.filter((event) => event.kind === "native.call").map((event) => event.name)).toEqual(["read"]);
    expect(ran.events.find((event) => event.kind === "text" && event.channel === "diagnostic")).toMatchObject({ text: 'Refused the agent\'s own tool write (edit): the agent\'s native tools are "read".' });
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
  });

  it("stops an agent that completes a tool of a kind its level does not include", async () => {
    const ran = await run("none", [{ own: { name: "shell", kind: "execute", input: { command: "rm -rf ." }, output: "done" } }, { say: "never said" }]);
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "error", detail: 'the ACP agent ran its own tool shell (execute) although the agent\'s native tools are "none", so the session was stopped' });
    expect(ran.events.some((event) => event.kind === "native.call")).toBe(false);
  });

  it("runs an ACP agent only in an engine sandbox", () => {
    const route = { provider: "openai-compatible", route: "main", contextTokens: 200_000, compactAt: 0.7 };
    const offer = { agent: { engines: ["opencode"], native: "none" }, model: { gatewayUrl: "http://localhost/model/v1", routes: [route] } } as never;
    expect(pickEngine(offer, ["opencode"], false)).toBeUndefined();
    expect(pickEngine(offer, ["opencode"], true)).toEqual({ id: "opencode", hosting: "sandboxed", route });
  });
});
