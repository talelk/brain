import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRef, Checkpoint, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import { runAgentExecution } from "../../apps/runner/src/engines/run";

// ADR 0045: a Pi attempt that did not finish leaves its conversation on the runner, and a later attempt on that runner starts from it. Driven
// through the real Pi engine and the runner's own execution path against a fake model endpoint that records every request it was sent.

const DIGEST = `sha256:${"0".repeat(64)}`;
const spec = (attemptId: string, extra: Partial<EngineSessionSpec> = {}): EngineSessionSpec => ({
  contractVersion: "brain.engine/v1", organizationId: "org-r", workspaceId: "ws-r", dispatchId: "d-r", jobId: `job-${attemptId}`, attemptId, runnerId: "runner-r",
  runnerEpoch: 1, leaseId: "lease-r", jobFence: 1, engine: { id: "pi", version: "1.4.0", adapterDigest: DIGEST, features: ["sessions", "checkpoint", "resume"] },
  modelId: "acme-large", instructions: "Follow the task.", instructionsDigest: DIGEST, task: "Remember the codeword ZEPHYR-42. Say STORED.", sourceRevision: `sha256:${"1".repeat(64)}`, worktreeId: "wt-r", configDigest: DIGEST,
  allowedTools: [], context: { artifactId: "ctx-r", digest: DIGEST, bytes: 0, mediaType: "application/json", classification: "internal" },
  limits: { timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 4 }, ...extra,
} as EngineSessionSpec);

type Asked = { messages: Array<{ role: string; content: unknown }> };

/** An OpenAI-compatible endpoint that lists its model, answers with a fixed text (or nothing, cut off) and keeps what it was asked. */
async function fakeModel(reply: { text: string; finish: "stop" | "length" }): Promise<{ url: string; asked: Asked[] }> {
  const asked: Asked[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "acme-large" }] })); return; }
      asked.push(JSON.parse(body) as Asked);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (reply.text) res.write(chunk({ role: "assistant", content: reply.text }, null));
      res.write(chunk({}, reply.finish));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "acme-large", choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env["BRAIN_LOCAL_MODEL_URL"] = url;
  process.env["BRAIN_LOCAL_MODEL_ID"] = "acme-large";
  return { url, asked };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); delete process.env["BRAIN_PI_AGENT_DIR"]; delete process.env["BRAIN_LOCAL_MODEL_URL"]; delete process.env["BRAIN_LOCAL_MODEL_ID"]; });

/** A runner's own state folder: a checkpoint lives here and nowhere else. */
function runnerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-resume-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function drain(engine: PiEngine, sessionId: string): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.events(sessionId, 0, new AbortController().signal)) events.push(event);
  return events;
}

/** One finished attempt whose conversation was then checkpointed. */
async function checkpointed(attemptId: string): Promise<Checkpoint> {
  const first = new PiEngine();
  const { sessionId } = await first.start(spec(attemptId), new AbortController().signal);
  await drain(first, sessionId);
  const checkpoint = await first.checkpoint(sessionId);
  await first.dispose(sessionId);
  return checkpoint;
}

const texts = (asked: Asked): string[] => asked.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));

describe("an engine that can resume continues a saved conversation (ADR 0045)", () => {
  it("starts a new session from the checkpoint: the model is asked with the earlier exchange, then the new task", async () => {
    const model = await fakeModel({ text: "STORED", finish: "stop" });
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    const checkpoint = await checkpointed("att-first");
    const state = checkpoint.engineState as ArtifactRef;
    expect(state).toMatchObject({ mediaType: "application/x-ndjson", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });

    // A different process of the same runner (a fresh adapter, the same state folder) resumes it as a new session.
    const resumed = new PiEngine();
    const { sessionId } = await resumed.start(spec("att-second", { resumeFrom: state, task: "What was the codeword?" }), new AbortController().signal);
    const events = await drain(resumed, sessionId);
    await resumed.dispose(sessionId);
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed" } });

    const asked = model.asked.at(-1)!;
    const said = texts(asked).join("\n");
    expect(said).toContain("Remember the codeword ZEPHYR-42");
    expect(said).toContain("STORED");
    expect(said).toContain("What was the codeword?");
    // The earlier exchange comes first, the new task last.
    expect(said.indexOf("ZEPHYR-42")).toBeLessThan(said.indexOf("What was the codeword?"));
    // A start with no checkpoint is a clean one: it knows nothing of the earlier exchange.
    const fresh = new PiEngine();
    const started = await fresh.start(spec("att-fresh", { task: "What was the codeword?" }), new AbortController().signal);
    await drain(fresh, started.sessionId);
    await fresh.dispose(started.sessionId);
    expect(texts(model.asked.at(-1)!).join("\n")).not.toContain("ZEPHYR-42");
  }, 120_000);

  it("refuses, with the reason, a checkpoint this runner does not hold, before anything starts", async () => {
    const model = await fakeModel({ text: "STORED", finish: "stop" });
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    const state = (await checkpointed("att-held")).engineState as ArtifactRef;
    const before = model.asked.length;

    // Another runner has its own state folder and no copy: the checkpoint is not on it.
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    await expect(new PiEngine().start(spec("att-elsewhere", { resumeFrom: state }), new AbortController().signal)).rejects.toThrow(/checkpoint is not on this runner/);
    // Nothing was asked of the model: the refusal came before any session started.
    expect(model.asked.length).toBe(before);
  }, 120_000);

  it("refuses a saved conversation whose bytes no longer match the checkpoint", async () => {
    await fakeModel({ text: "STORED", finish: "stop" });
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    const state = (await checkpointed("att-tamper")).engineState as ArtifactRef;
    await expect(new PiEngine().start(spec("att-tamper-size", { resumeFrom: { ...state, bytes: state.bytes + 1 } }), new AbortController().signal)).rejects.toThrow(/does not match the checkpoint/);
    await expect(new PiEngine().start(spec("att-tamper-digest", { resumeFrom: { ...state, digest: `sha256:${"f".repeat(64)}` } }), new AbortController().signal)).rejects.toThrow(/checkpoint is not on this runner/);
  }, 120_000);
});

describe("the runner's attempt path (ADR 0045)", () => {
  const input = (engine: PiEngine | FixtureEngine, attemptId: string, extra: Record<string, unknown> = {}) => ({
    engine, attemptId, jobFence: 1, leaseId: "lease-r", runnerId: "runner-r", organizationId: "org-r", workspaceId: "ws-r", jobId: `job-${attemptId}`, configDigest: DIGEST,
    instructions: "Follow the task.", task: "Remember the codeword ZEPHYR-42. Say STORED.", modelId: "acme-large", timeoutMs: 60_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 4,
    emit: async () => undefined, signal: new AbortController().signal, ...extra,
  });

  it("leaves a checkpoint behind when an attempt does not finish, and a resumed attempt on the same runner continues from it", async () => {
    // The model is cut off before it answers: the attempt fails, but its conversation up to there is worth keeping.
    const model = await fakeModel({ text: "", finish: "length" });
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    const failed = await runAgentExecution(input(new PiEngine(), "att-cut-off"));
    expect(failed.ok).toBe(false);
    expect(failed.checkpoint).toMatchObject({ contractVersion: "brain.checkpoint/v2", attemptId: "att-cut-off", engineState: { mediaType: "application/x-ndjson" } });

    const answering = await fakeModel({ text: "ZEPHYR-42", finish: "stop" });
    const resumed = await runAgentExecution(input(new PiEngine(), "att-resumed", { task: "What was the codeword?", resumeFrom: failed.checkpoint!.engineState }));
    expect(resumed).toMatchObject({ ok: true, outputText: "ZEPHYR-42" });
    expect(resumed.checkpoint).toBeUndefined();
    expect(texts(answering.asked.at(-1)!).join("\n")).toContain("Remember the codeword ZEPHYR-42");
    void model;
  }, 120_000);

  it("never saves a checkpoint for an attempt that finished", async () => {
    await fakeModel({ text: "STORED", finish: "stop" });
    process.env["BRAIN_PI_AGENT_DIR"] = runnerDir();
    const done = await runAgentExecution(input(new PiEngine(), "att-done"));
    expect(done.ok).toBe(true);
    expect(done.checkpoint).toBeUndefined();
  }, 120_000);

  it("refuses a checkpoint on an engine that cannot resume, and says so", async () => {
    const refused = await runAgentExecution(input(new FixtureEngine(), "att-fixture", { resumeFrom: { artifactId: "a", digest: `sha256:${"a".repeat(64)}`, bytes: 1, mediaType: "application/x-ndjson", classification: "internal" } }));
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatchObject({ error: expect.stringMatching(/fixture cannot resume a saved conversation/) });
    expect(refused.checkpoint).toBeUndefined();
  });
});
