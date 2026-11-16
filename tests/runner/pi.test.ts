import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { NativeLevel } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import type { EngineEvent, EngineSessionSpec } from "../../apps/runner/src/engines/port";
import { tempDir } from "./git-repo";

/**
 * The Pi adapter against the real Pi library and a scripted model gateway on loopback (OpenAI-compatible chat completions, streamed).
 * No model is involved: the gateway answers each request with the next step of the script, a tool call or the final text.
 */
type Step = { tool: string; args: Record<string, unknown> } | { text: string };
interface Seen { authorization: string | undefined; model: unknown; tools: string[]; path: string }

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function gateway(steps: Step[]): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: unknown; tools?: Array<{ function?: { name?: string } }> };
      const step = steps[seen.length] ?? { text: "nothing left in the script" };
      seen.push({ authorization: request.headers.authorization, model: body.model, tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""), path: request.url ?? "" });
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: `c${seen.length}`, object: "chat.completion.chunk", created: 1, model: "main", choices, ...extra })}\n\n`;
      const delta = "tool" in step
        ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: "assistant", content: step.text };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk([{ index: 0, delta, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: "tool" in step ? "tool_calls" : "stop" }]) + chunk([], { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + "data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

async function run(native: NativeLevel, steps: Step[], limits: Partial<EngineSessionSpec["limits"]> = {}): Promise<{ events: EngineEvent[]; seen: Seen[]; workDir: string; requests: Array<[string, unknown]> }> {
  const { baseUrl, seen } = await gateway(steps);
  const workDir = tempDir("pi-work");
  const stateDir = tempDir("pi-state");
  const engine = new PiEngine();
  const spec: EngineSessionSpec = {
    attemptId: "a1", instructions: "You are a test agent.", task: "Do the scripted work.", model: { baseUrl, token: "attempt-token", name: "main" }, native, workDir, outDir: stateDir, stateDir,
    tools: [{ name: "task.note", description: "Writes a note on the shared board.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, effect: "read" }],
    limits: { timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 20, ...limits },
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

const kinds = (events: EngineEvent[]): string[] => events.map((event) => event.kind);

describe("the Pi adapter", () => {
  it("is ready when the Pi library is installed", async () => {
    expect(await new PiEngine().probe()).toMatchObject({ id: "pi", ready: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/u) as string });
  });

  it("offers Pi's own tools at native all, runs them in the working copy and reports each as a native call", async () => {
    const ran = await run("all", [
      { tool: "write", args: { path: "notes/a.md", content: "hello from pi\n" } },
      { tool: "bash", args: { command: "cat notes/a.md && pwd" } },
      { tool: "task_note", args: { text: "wrote the note" } },
      { text: "Wrote notes/a.md." },
    ]);
    // The gateway is called with the attempt's token and the route as the model; the model is offered exactly Pi's tools and the workspace tool.
    expect(ran.seen).toHaveLength(4);
    expect(ran.seen[0]).toMatchObject({ authorization: "Bearer attempt-token", model: "main", path: "/v1/chat/completions" });
    expect([...ran.seen[0]!.tools].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "task_note", "write"]);
    expect(readFileSync(join(ran.workDir, "notes/a.md"), "utf8")).toBe("hello from pi\n");
    const calls = ran.events.filter((event) => event.kind === "native.call");
    expect(calls.map((event) => [event.name, event.input])).toEqual([["write", { path: "notes/a.md", content: "hello from pi\n" }], ["bash", { command: "cat notes/a.md && pwd" }]]);
    const results = ran.events.filter((event) => event.kind === "native.result");
    expect(results.map((event) => [event.callId, event.ok])).toEqual(calls.map((event) => [event.callId, true]));
    expect(results[1]!.output).toContain("hello from pi");
    expect(results[1]!.output).toContain(ran.workDir);
    // The workspace tool is not a native call: it goes to the runner.
    expect(ran.requests).toEqual([["task.note", { text: "wrote the note" }]]);
    expect(ran.events.filter((event) => event.kind === "text" && event.channel === "assistant").map((event) => (event as { text: string }).text)).toEqual(["Wrote notes/a.md."]);
    expect(ran.events.filter((event) => event.kind === "usage").at(-1)).toMatchObject({ inputTokens: 400, outputTokens: 80, turns: 4 });
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
  });

  it("offers only reading and searching at native read, and nothing of its own at native none", async () => {
    const read = await run("read", [{ tool: "write", args: { path: "b.md", content: "must not exist" } }, { text: "I cannot write." }]);
    expect([...read.seen[0]!.tools].sort()).toEqual(["find", "grep", "ls", "read", "task_note"]);
    // A model that calls a tool it was not offered gets an error from Pi; nothing is written and nothing is reported as a native call.
    expect(existsSync(join(read.workDir, "b.md"))).toBe(false);
    expect(kinds(read.events)).not.toContain("native.call");
    const none = await run("none", [{ text: "Nothing to do." }]);
    expect(none.seen[0]!.tools).toEqual(["task_note"]);
    expect(none.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
  });

  it("stops a session that keeps calling tools past the agent's turns, with the numbers as the reason", async () => {
    const ran = await run("all", Array.from({ length: 8 }, (_unused, index) => ({ tool: "bash", args: { command: `echo ${index}` } })), { maxTurns: 3 });
    expect(ran.events.at(-1)).toMatchObject({ kind: "stopped", reason: "limit" });
    expect((ran.events.at(-1) as { detail: string }).detail).toMatch(/of 3 turns/u);
    expect(ran.seen.length).toBeLessThanOrEqual(5);
  });
});
