import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { NativeLevel } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeEngine } from "../../apps/runner/src/engines/claude";
import type { EngineEvent, EngineSessionSpec } from "../../apps/runner/src/engines/port";
import { tempDir } from "./git-repo";

/**
 * The Claude adapter against the real Claude Agent SDK and a scripted model gateway on loopback (Anthropic Messages, streamed). No model
 * is involved: the gateway answers each request of the agent loop with the next step of the script, a tool call or the final text.
 */
type Step = { tool: string; args: Record<string, unknown> } | { text: string };
interface Seen { authorization: string | undefined; apiKey: string | undefined; model: unknown; tools: string[]; path: string }

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });

async function gateway(steps: Step[]): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method !== "POST" || !(request.url ?? "").startsWith("/model/v1/messages") || (request.url ?? "").includes("count_tokens")) { response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not served" } })); return; }
      const body = JSON.parse(raw || "{}") as { model?: unknown; stream?: boolean; tools?: Array<{ name?: string }> };
      const tools = (body.tools ?? []).map((tool) => tool.name ?? "");
      // The agent loop is the request that carries the workspace tool; anything else the CLI asks on the side gets a plain word.
      const main = tools.some((name) => name.startsWith("mcp__brain__"));
      const step: Step = main ? steps[seen.length] ?? { text: "nothing left in the script" } : { text: "ok" };
      if (main) seen.push({ authorization: request.headers.authorization, apiKey: request.headers["x-api-key"] as string | undefined, model: body.model, tools, path: request.url ?? "" });
      const id = `msg_${seen.length}_${Math.random().toString(36).slice(2, 8)}`;
      const content = "tool" in step ? { type: "tool_use", id: `toolu_${seen.length}`, name: step.tool, input: step.args } : { type: "text", text: step.text };
      const stop = "tool" in step ? "tool_use" : "end_turn";
      if (body.stream !== true) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id, type: "message", role: "assistant", model: "main", content: [content], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } })); return; }
      const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const blocks = "tool" in step
        ? event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${seen.length}`, name: step.tool, input: {} } }) + event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.args) } })
        : event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text } });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(event("message_start", { message: { id, type: "message", role: "assistant", model: "main", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }) + blocks
        + event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }) + event("message_stop", {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The gateway's address as an offer carries it; the Anthropic form is served at `<gateway>/messages`.
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model/v1`, seen };
}

async function run(native: NativeLevel, steps: Step[]): Promise<{ events: EngineEvent[]; seen: Seen[]; workDir: string; requests: Array<[string, unknown]> }> {
  const { baseUrl, seen } = await gateway(steps);
  const workDir = tempDir("claude-work");
  const stateDir = tempDir("claude-state");
  const engine = new ClaudeEngine();
  const spec: EngineSessionSpec = {
    attemptId: "a1", instructions: "You are a test agent.", task: "Do the scripted work.", model: { baseUrl, token: "attempt-token", name: "main" }, native, workDir, outDir: stateDir, stateDir,
    tools: [{ name: "task.note", description: "Writes a note on the shared board.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, effect: "read" }],
    limits: { timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 20 },
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
  return { events, seen, workDir, requests };
}

const BUILT_IN = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Task", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"];
const builtIn = (seen: Seen): string[] => seen.tools.filter((name) => BUILT_IN.includes(name)).sort();

describe("the Claude adapter", () => {
  it("offers Claude's own tools at native all, runs them in the working copy and reports each as a native call", async () => {
    const ran = await run("all", [
      { tool: "Write", args: { file_path: "notes/a.md", content: "hello from claude\n" } },
      { tool: "Bash", args: { command: "cat notes/a.md && pwd" } },
      { tool: "mcp__brain__task_note", args: { text: "wrote the note" } },
      { text: "Wrote notes/a.md." },
    ]);
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
    expect(ran.seen[0]).toMatchObject({ model: "main", path: expect.stringMatching(/^\/model\/v1\/messages/u) as string });
    expect([ran.seen[0]!.authorization, ran.seen[0]!.apiKey]).toContain("Bearer attempt-token");
    expect(builtIn(ran.seen[0]!)).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    expect(ran.seen[0]!.tools).toContain("mcp__brain__task_note");
    expect(readFileSync(join(ran.workDir, "notes/a.md"), "utf8")).toBe("hello from claude\n");
    const calls = ran.events.filter((event) => event.kind === "native.call");
    expect(calls.map((event) => event.name)).toEqual(["Write", "Bash"]);
    const results = ran.events.filter((event) => event.kind === "native.result");
    expect(results.map((event) => [event.callId, event.ok])).toEqual(calls.map((event) => [event.callId, true]));
    expect(results[1]!.output).toContain("hello from claude");
    expect(ran.requests).toEqual([["task.note", { text: "wrote the note" }]]);
    expect(ran.events.filter((event) => event.kind === "text" && event.channel === "assistant").map((event) => (event as { text: string }).text)).toEqual(["Wrote notes/a.md."]);
    expect(ran.events.filter((event) => event.kind === "usage").at(-1)).toMatchObject({ turns: 4 });
  }, 120_000);

  it("offers only reading and searching at native read, and nothing of its own at native none", async () => {
    const read = await run("read", [{ tool: "Write", args: { file_path: "b.md", content: "must not exist" } }, { text: "I cannot write." }]);
    expect(builtIn(read.seen[0]!)).toEqual(["Glob", "Grep", "Read"]);
    expect(existsSync(join(read.workDir, "b.md"))).toBe(false);
    const none = await run("none", [{ text: "Nothing to do." }]);
    expect(builtIn(none.seen[0]!)).toEqual([]);
    expect(none.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
  }, 120_000);
});
