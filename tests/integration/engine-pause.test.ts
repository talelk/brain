import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineToolBinding, EngineToolExecutionResult, ReleaseRef } from "@brain/contracts";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import { ClaudeEngine } from "../../apps/runner/src/engines/claude";
import { runAgentExecution, type AgentExecutionInput } from "../../apps/runner/src/engines/run";

// ADR 0058: the engine seam of pausing one session. Driven through the real Pi engine and the runner's own execution path against a fake model
// endpoint that records every request it was sent: a pause is taken at the turn boundary (no request reaches the model while held), a continue
// goes on with the very same session, a stop while held ends it at once with its conversation kept, and the execution deadline does not run down.

const DIGEST = `sha256:${"0".repeat(64)}`;
const tool: ReleaseRef = { id: "host.exec", digest: `sha256:${"a".repeat(64)}` };
const binding = { release: tool, inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, effectClass: "read", target: { targetId: "t", environmentId: "e", preconditionDigest: DIGEST } } as unknown as EngineToolBinding;

type Asked = { messages: Array<{ role: string; content: unknown }> };

/** An OpenAI-compatible endpoint: while the conversation has no tool answer it asks for one tool call (`calls` times), then it writes its answer. */
async function fakeModel(options: { toolCalls: number }): Promise<{ asked: Asked[] }> {
  const asked: Asked[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "acme-large" }] })); return; }
      const request = JSON.parse(body) as Asked;
      asked.push(request);
      const answered = request.messages.filter((message) => message.role === "tool").length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (answered < options.toolCalls) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${answered + 1}`, type: "function", function: { name: "brain_host_exec", arguments: JSON.stringify({ command: `step-${answered + 1}` }) } }] }, null));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "FINISHED" }, null));
        res.write(chunk({}, "stop"));
      }
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  process.env["BRAIN_LOCAL_MODEL_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env["BRAIN_LOCAL_MODEL_ID"] = "acme-large";
  const dir = mkdtempSync(join(tmpdir(), "brain-pause-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env["BRAIN_PI_AGENT_DIR"] = dir;
  return { asked };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); delete process.env["BRAIN_PI_AGENT_DIR"]; delete process.env["BRAIN_LOCAL_MODEL_URL"]; delete process.env["BRAIN_LOCAL_MODEL_ID"]; });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const said = (asked: Asked): string => asked.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");

type Handle = Parameters<NonNullable<AgentExecutionInput["onSession"]>>[0];

/** Runs one attempt as the runner does; `onTool` runs while the model's first tool call is being answered (the session is mid-turn). */
function attempt(extra: Partial<AgentExecutionInput> & { onTool: (handle: Handle, calls: number) => void }) {
  const { onTool, ...rest } = extra;
  const controller = new AbortController();
  const events: Array<{ kind: string; sessionId?: string }> = [];
  let handle: Handle | undefined;
  let calls = 0;
  const done = runAgentExecution({
    engine: new PiEngine([binding]), attemptId: "att-pause", jobFence: 1, leaseId: "lease-p", runnerId: "runner-p", organizationId: "org-p", workspaceId: "ws-p", jobId: "job-pause", configDigest: DIGEST,
    instructions: "Follow the task.", task: "Run the steps.", modelId: "acme-large", timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 6, allowedTools: [tool],
    onSession: (opened) => { handle = opened; },
    executeTool: async (proposal) => {
      calls += 1;
      onTool(handle!, calls);
      return { proposalId: proposal.proposalId, invocationId: `inv-${calls}`, receipt: { invocationId: `inv-${calls}`, attemptId: "att-pause", jobFence: 1, result: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), effects: [] }, output: { ok: calls } } as unknown as EngineToolExecutionResult;
    },
    emit: async (_kind, payload) => { events.push(payload as { kind: string; sessionId?: string }); },
    signal: controller.signal, ...rest,
  });
  return { done, controller, events, handle: () => handle! };
}

describe("pausing a Pi session at a turn boundary (ADR 0058)", () => {
  it("advertises pause only for an engine that can stop at a turn boundary", async () => {
    await fakeModel({ toolCalls: 0 });
    expect((await new PiEngine().probe()).features).toContain("pause");
    expect((await new FixtureEngine().probe()).features).not.toContain("pause");
    expect((await new ClaudeEngine().probe()).features).not.toContain("pause");
  }, 60_000);

  it("holds at the boundary with no request to the model, then continues the very same session, picking up a steer sent while held", async () => {
    const model = await fakeModel({ toolCalls: 2 });
    let paused: Promise<void> | undefined;
    let pausedAt = 0;
    const run = attempt({ onTool: (handle, calls) => { if (calls === 1) paused = handle.pause().then(() => { pausedAt = model.asked.length; }); } });
    // The pause was asked during the first tool call and is taken when that turn is over: after the first request and before the second.
    await new Promise<void>((resolve) => { const poll = setInterval(() => { if (paused) { clearInterval(poll); resolve(); } }, 20); });
    await paused;
    expect(pausedAt).toBe(1);
    const sessionBefore = run.handle().sessionId;
    // Held: nothing is sent to the model however long it waits, and the attempt has not ended.
    await sleep(1500);
    expect(model.asked).toHaveLength(1);
    let ended = false;
    void run.done.then(() => { ended = true; });
    await sleep(100);
    expect(ended).toBe(false);
    // Steering still works while held: the message waits for the engine's first request after the continue.
    await run.handle().steer("m-1", "Look at the second source first");
    await sleep(300);
    expect(model.asked).toHaveLength(1);

    await run.handle().continue();
    const result = await run.done;
    expect(result).toMatchObject({ ok: true, outputText: "FINISHED", cleanupConfirmed: true });
    expect(model.asked).toHaveLength(3);
    // The same session went on: one session id in all of the events, no restart, and its conversation (the first tool answer) is in the next request.
    expect(run.handle().sessionId).toBe(sessionBefore);
    expect(new Set(run.events.map((event) => event.sessionId).filter(Boolean))).toEqual(new Set([sessionBefore]));
    expect(said(model.asked[1]!)).toContain(`{"ok":1}`);
    expect(said(model.asked[1]!)).toContain("[steer:m-1] Look at the second source first");
  }, 120_000);

  it("a stop while held ends the session at once, confirmed, with its conversation kept for a resume", async () => {
    const model = await fakeModel({ toolCalls: 2 });
    let paused: Promise<void> | undefined;
    const run = attempt({ onTool: (handle, calls) => { if (calls === 1) paused = handle.pause(); } });
    await new Promise<void>((resolve) => { const poll = setInterval(() => { if (paused) { clearInterval(poll); resolve(); } }, 20); });
    await paused;
    await sleep(300);
    const started = Date.now();
    run.controller.abort(new Error("stop requested"));
    const result = await run.done;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.checkpoint).toMatchObject({ attemptId: "att-pause", engineState: { mediaType: "application/x-ndjson" } });
    expect(model.asked).toHaveLength(1);
  }, 120_000);

  it("a pause the session never reaches a boundary for is not taken: an answer with no tool call ends it, and the pause is reported not taken", async () => {
    await fakeModel({ toolCalls: 0 });
    let outcome: Promise<string> | undefined;
    let handle: Handle | undefined;
    const done = runAgentExecution({
      engine: new PiEngine(), attemptId: "att-plain", jobFence: 1, leaseId: "lease-p", runnerId: "runner-p", organizationId: "org-p", workspaceId: "ws-p", jobId: "job-plain", configDigest: DIGEST,
      instructions: "Follow the task.", task: "Just answer.", modelId: "acme-large", timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 2,
      onSession: (opened) => { handle = opened; outcome = opened.pause().then(() => "held", (error: Error) => error.message); },
      emit: async () => undefined, signal: new AbortController().signal,
    });
    const result = await done;
    expect(result).toMatchObject({ ok: true, outputText: "FINISHED" });
    expect(await outcome).toMatch(/finished before it reached a turn boundary/u);
    expect(handle).toBeDefined();
  }, 120_000);

  it("a continue asked before the boundary cancels the pause: the session never stops", async () => {
    const model = await fakeModel({ toolCalls: 2 });
    let outcome: Promise<string> | undefined;
    const run = attempt({ onTool: (handle, calls) => { if (calls === 1) { outcome = handle.pause().then(() => "held", (error: Error) => error.message); void handle.continue(); } } });
    const result = await run.done;
    expect(result).toMatchObject({ ok: true, outputText: "FINISHED" });
    expect(await outcome).toMatch(/cancelled before it was reached/u);
    expect(model.asked).toHaveLength(3);
  }, 120_000);

  it("the execution deadline stops counting while held and goes on after the continue", async () => {
    const model = await fakeModel({ toolCalls: 2 });
    let paused: Promise<void> | undefined;
    // Eight seconds is more than enough for the work and far less than the time the session is held for.
    const run = attempt({ timeoutMs: 8_000, onTool: (handle, calls) => { if (calls === 1) paused = handle.pause(); } });
    await new Promise<void>((resolve) => { const poll = setInterval(() => { if (paused) { clearInterval(poll); resolve(); } }, 20); });
    await paused;
    await sleep(9_000);
    expect(model.asked).toHaveLength(1);
    await run.handle().continue();
    expect(await run.done).toMatchObject({ ok: true, outputText: "FINISHED" });
  }, 120_000);
});
