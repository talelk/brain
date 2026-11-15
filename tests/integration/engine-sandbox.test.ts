import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAdapter, EngineSessionSpec, EngineToolBinding } from "@brain/contracts";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import { attemptEngine, hostInit, modelHosts, type AttemptSandbox } from "../../apps/runner/src/engines/hosting";
import { advertisedCapabilities, advertisedIsolationModes, engineHosting, engineIsolation } from "../../apps/runner/src/engines/isolation";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { serveEngineHost } from "../../apps/runner/src/engines/sandbox-host";
import { decodeFrame, type HostRequest } from "../../apps/runner/src/engines/sandbox-protocol";
import { prepareAttemptState, SandboxedEngine, type EngineChannel, type EngineSandboxOpener, type EngineSandboxRequest } from "../../apps/runner/src/engines/sandboxed";

// ADR 0067 at the runner's engine-adapter seam. The launcher is a test double whose "container" serves the real engine host in this
// process over an in-memory pipe, with the fixture engine behind it; nothing is a real container, model or Docker.

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const BINDING = { release: { id: "fixture.echo", digest: digest("a") }, inputSchema: { type: "object" }, effectClass: "read", target: { targetId: "t", environmentId: "e", preconditionDigest: digest("b") } } as unknown as EngineToolBinding;

interface Harness {
  readonly opener: EngineSandboxOpener;
  readonly opened: EngineSandboxRequest[];
  /** What the runner wrote to the container, every line. */
  readonly sent: string[];
  /** Ops the host served, by name. */
  readonly ops: string[];
  readonly selected: string[];
  readonly applied: Array<{ env: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>> }>;
  closed: number;
  /** Ends the container's output as if it had died. */
  die(): void;
}

function harness(options: { refuse?: string } = {}): Harness {
  const h: Harness = { opened: [], sent: [], ops: [], selected: [], applied: [], closed: 0, die: () => undefined, opener: undefined as never };
  const opener: EngineSandboxOpener = {
    open: async (request): Promise<EngineChannel> => {
      h.opened.push(request);
      if (options.refuse) throw new Error(options.refuse);
      const toHost = new PassThrough();
      const fromHost = new PassThrough();
      let dead = false;
      const host = serveEngineHost(toHost, (text) => { if (!dead) fromHost.write(text); }, {
        select: (init) => { h.selected.push(init.engine); return new FixtureEngine(init.toolBindings); },
        applyEnvironment: (env, secrets) => { h.applied.push({ env, secrets }); },
      });
      h.die = () => { dead = true; fromHost.end(); };
      return {
        send: async (line) => { h.sent.push(line); const op = decodeFrame<HostRequest>(line.trim()); if (op) h.ops.push(op.op); toHost.write(line.endsWith("\n") ? line : `${line}\n`); },
        lines: () => createInterface({ input: fromHost, crlfDelay: Infinity })[Symbol.asyncIterator](),
        close: async () => { h.closed += 1; toHost.end(); await host; fromHost.end(); return { terminationConfirmed: true }; },
      };
    },
  };
  return Object.assign(h, { opener });
}

let root = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "brain-engine-state-")); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
const setEnv = (name: string, value: string | undefined): void => { if (!(name in saved)) saved[name] = process.env[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; };

const sandboxOf = (h: Harness, over: Partial<AttemptSandbox> = {}): AttemptSandbox => ({
  support: { opener: h.opener, stateRoot: root }, attemptId: "att-1", resources: { cpuMillicores: 2000, memoryMb: 4096 }, workspaceHosts: ["wiki.example.com"], routeIndex: 0, ...over,
});
const ROUTE = { routeId: "r1", baseUrl: "https://models.example.com/v1", model: "big", keyRef: "route-key", inputMicroUsdPerMTok: 1, outputMicroUsdPerMTok: 1 };
const sessionSpec = (): EngineSessionSpec => JSON.parse(readFileSync("examples/v1/transport/EngineSessionSpec.json", "utf8")) as EngineSessionSpec;

const run = (engine: EngineAdapter, task = "{\"situation\":\"hello\"}", executeTool?: Parameters<typeof runAgentExecution>[0]["executeTool"]) => runAgentExecution({
  engine, attemptId: "att-1", jobFence: 1, leaseId: "l", runnerId: "r", organizationId: "o", workspaceId: "w", jobId: "j", configDigest: digest("d"),
  task, timeoutMs: 5000, emit: async () => undefined, signal: new AbortController().signal,
  allowedTools: [BINDING.release], ...(executeTool ? { executeTool } : {}),
});

describe("the isolation a runner states is the one its engines have", () => {
  it("only an engine that runs in a sandbox claims ephemeral-container; the fixture runs no model or tool so it keeps it", () => {
    for (const id of ["pi", "claude", "acp", "opencode"]) {
      expect(engineIsolation(id, false), `${id} in the runner process`).toBe("trusted-local");
      expect(engineHosting(id, false)).toBe("in-process");
      expect(engineIsolation(id, true), `${id} in its sandbox`).toBe("ephemeral-container");
      expect(engineHosting(id, true)).toBe("sandboxed");
    }
    expect(engineIsolation("fixture", false)).toBe("ephemeral-container");
    expect(engineIsolation("fixture", true)).toBe("ephemeral-container");
    expect(engineHosting("fixture", true)).toBe("in-process");
    expect(engineIsolation("something-new", true)).toBe("trusted-local");
  });

  it("the hello and heartbeat statements follow it", () => {
    const engines = [{ id: "pi", features: ["sessions"] }, { id: "acp", features: ["sessions"] }, { id: "fixture", features: ["sessions"] }];
    const without = advertisedCapabilities(["isolation:ephemeral-container", "engine-isolation:pi:ephemeral-container"], engines, false);
    expect(without).toEqual(expect.arrayContaining(["engine-isolation:pi:trusted-local", "engine-isolation:acp:trusted-local", "engine-isolation:fixture:ephemeral-container"]));
    expect(without).not.toContain("engine-isolation:pi:ephemeral-container");
    const withSandbox = advertisedCapabilities([], engines, true);
    expect(withSandbox).toEqual(expect.arrayContaining(["engine-isolation:pi:ephemeral-container", "engine-isolation:acp:ephemeral-container", "engine-isolation:fixture:ephemeral-container"]));
    expect(advertisedIsolationModes(engines, false).sort()).toEqual(["ephemeral-container", "trusted-local"]);
    expect(advertisedIsolationModes([{ id: "pi" }], true)).toEqual(["ephemeral-container"]);
  });

  it("an engine is run where the statement says: sandboxed when it claims a container, never in the runner process", () => {
    const h = harness();
    for (const id of ["pi", "claude", "acp", "opencode"]) {
      expect(attemptEngine(id, [], undefined, sandboxOf(h)), id).toBeInstanceOf(SandboxedEngine);
      expect(attemptEngine(id, [], undefined, undefined), `${id} with no sandbox support`).not.toBeInstanceOf(SandboxedEngine);
    }
    // The fixture runs in-process whatever the runner has, and says so.
    expect(attemptEngine("fixture", [], undefined, sandboxOf(h))).toBeInstanceOf(FixtureEngine);
    expect(attemptEngine("unknown", [], undefined, sandboxOf(h))).toBeUndefined();
  });
});

describe("an attempt's engine runs behind the engine port in its own sandbox", () => {
  it("asks the launcher for the reservation's limits and the workspace's hosts plus the model's, and carries the key only in the init frame", async () => {
    setEnv("BRAIN_MODEL_KEY_ROUTE_KEY", "sk-route-secret-value-123456");
    setEnv("DATABASE_PASSWORD", "must-never-travel");
    setEnv("BRAIN_LOCAL_MODEL_API_KEY", "sk-local-secret-value-123456");
    const h = harness();
    const engine = attemptEngine("pi", [BINDING], ROUTE, sandboxOf(h)) as SandboxedEngine;
    const started = await engine.start({ ...sessionSpec(), attemptId: "att-1" }, new AbortController().signal);
    expect(started.sessionId).toBeTruthy();
    expect(h.opened).toEqual([{ engine: "pi", attemptId: "att-1", requestId: "engine-att-1-0", cpuMillicores: 2000, memoryMb: 4096, egressHosts: ["wiki.example.com", "models.example.com"] }]);
    // The request to the launcher holds no credential and no path; the key reaches the engine host in the init frame.
    expect(JSON.stringify(h.opened)).not.toMatch(/sk-|secret|DATABASE/u);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.secrets).toEqual({ BRAIN_LOCAL_MODEL_API_KEY: "sk-local-secret-value-123456", BRAIN_MODEL_KEY_ROUTE_KEY: "sk-route-secret-value-123456" });
    expect(JSON.stringify(h.applied[0]!.env)).not.toMatch(/sk-|must-never-travel/u);
    expect(h.selected).toEqual(["pi"]);
    expect(existsSync(join(root, "att-1"))).toBe(true);
    await engine.cancel(started.sessionId, "done");
    await engine.dispose(started.sessionId);
    expect((await engine.close()).terminationConfirmed).toBe(true);
    expect(h.closed).toBe(1);
    // The attempt saved no conversation, so its state goes with it.
    expect(existsSync(join(root, "att-1"))).toBe(false);
  });

  it("runs a whole step through it: events come back, a tool proposal is answered by the runner, the answer is the engine's", async () => {
    const h = harness();
    const engine = new SandboxedEngine({
      engineId: "pi", opener: h.opener, attemptId: "att-1", requestId: "engine-att-1-0", cpuMillicores: 1000, memoryMb: 1024,
      egressHosts: [], init: () => hostInit("pi", [BINDING], undefined), stateRoot: root,
    });
    const proposals: string[] = [];
    const task = JSON.stringify({ situation: `check the page\nFIXTURE_CALL_TOOL ${JSON.stringify({ id: "fixture.echo", input: { message: "hi" } })}` });
    const result = await run(engine, task, async (proposal) => {
      proposals.push(proposal.proposalId);
      return { proposalId: proposal.proposalId, invocationId: "inv-1", receipt: { result: "succeeded" } as never, output: { echoed: "hi" } };
    });
    await engine.close();
    expect(result.ok, JSON.stringify(result.output)).toBe(true);
    expect(proposals).toHaveLength(1);
    expect(result.outputText).toContain("Fixture: check the page");
    expect(h.ops).toEqual(expect.arrayContaining(["init", "probe", "start", "events", "toolResult", "dispose"]));
    expect(h.opened).toHaveLength(1);
  });

  it("never runs the engine in the runner when the sandbox cannot start: the attempt fails with the launcher's reason", async () => {
    const refused = harness({ refuse: "engine sandbox create failed 503: docker run failed: Unable to find image 'brain-sandbox-engine:latest' locally" });
    const engine = attemptEngine("pi", [BINDING], undefined, sandboxOf(refused)) as SandboxedEngine;
    const result = await run(engine);
    expect(result.ok).toBe(false);
    expect((result.output as { error: string }).error).toMatch(/engine sandbox create failed 503: docker run failed: Unable to find image/u);
    // No engine was built anywhere: not behind the sandbox, and not in this process.
    expect(refused.selected).toEqual([]);
    expect(refused.ops).toEqual([]);
    expect(refused.opened).toHaveLength(1);
  });

  it("a launcher that fails in its own words is still an engine sandbox failure, and one that cannot be reached too", async () => {
    const odd = harness({ refuse: "connect ENOENT /launcher/launcher.sock" });
    const result = await run(attemptEngine("claude", [BINDING], undefined, sandboxOf(odd)) as SandboxedEngine);
    expect(result.ok).toBe(false);
    expect((result.output as { error: string }).error).toMatch(/^engine sandbox create failed: connect ENOENT/u);
    expect(odd.selected).toEqual([]);

    // A sandboxed engine without a launcher behind it fails the same way (it is never given an in-process engine).
    const bare = new SandboxedEngine({
      engineId: "pi", opener: undefined, attemptId: "att-9", requestId: "engine-att-9-0", cpuMillicores: 1000, memoryMb: 512,
      egressHosts: [], init: () => hostInit("pi", [], undefined), stateRoot: root,
    });
    const bareResult = await run(bare);
    expect(bareResult.ok).toBe(false);
    expect((bareResult.output as { error: string }).error).toMatch(/engine sandbox create failed: this runner has no launcher/u);
  });

  it("a sandbox that dies mid-session fails the attempt; it is not restarted in the runner", async () => {
    const h = harness();
    const engine = attemptEngine("pi", [BINDING], undefined, sandboxOf(h)) as SandboxedEngine;
    const started = await engine.start({ ...sessionSpec(), attemptId: "att-1" }, new AbortController().signal);
    const iterator = engine.events(started.sessionId, 0, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    h.die();
    await expect((async () => { for (;;) { const next = await iterator.next(); if (next.done) return "ended"; } })()).rejects.toThrow(/engine sandbox exec failed: the container ended/u);
    expect(h.opened).toHaveLength(1);
    expect(h.selected).toEqual(["pi"]);
    await engine.close();
  });

  it("when the runner closes the channel the host cancels its engine and ends", async () => {
    const h = harness();
    const engine = attemptEngine("claude", [BINDING], undefined, sandboxOf(h, { attemptId: "att-2" })) as SandboxedEngine;
    await engine.start({ ...sessionSpec(), attemptId: "att-2" }, new AbortController().signal);
    expect((await engine.close()).terminationConfirmed).toBe(true);
    expect(h.closed).toBe(1);
  });
});

describe("what an attempt's sandbox may reach", () => {
  it("names the model's host from the route, else from the runner's own setting for the engine, else the operator's list", () => {
    expect(modelHosts("pi", ROUTE, {})).toEqual(["models.example.com"]);
    expect(modelHosts("claude", { ...ROUTE, baseUrl: "http://gateway.internal:8080/v1" }, {})).toEqual(["gateway.internal:8080"]);
    expect(modelHosts("pi", undefined, { BRAIN_LOCAL_MODEL_URL: "http://Models.Internal:8000/v1" })).toEqual(["models.internal:8000"]);
    expect(modelHosts("pi", undefined, {})).toEqual(["tntungx10:8000"]);
    expect(modelHosts("claude", undefined, {})).toEqual(["api.anthropic.com"]);
    expect(modelHosts("claude", undefined, { BRAIN_ANTHROPIC_BASE_URL: "https://llm.example.com" })).toEqual(["llm.example.com"]);
    expect(modelHosts("acp", undefined, { BRAIN_ENGINE_MODEL_HOSTS: "a.example.com, B.example.com:8443" })).toEqual(["a.example.com", "b.example.com:8443"]);
    expect(modelHosts("opencode", undefined, {})).toEqual([]);
  });

  it("gives the host only the settings and credentials an engine reads, by name", () => {
    const env = { BRAIN_LOCAL_MODEL_URL: "http://m:8000/v1", BRAIN_LOCAL_MODEL_API_KEY: "k1", ANTHROPIC_API_KEY: "k2", BRAIN_MODEL_KEY_ROUTE_KEY: "k3", BRAIN_MODEL_KEY_OTHER: "k4", HOME: "/home/x", AWS_SECRET_ACCESS_KEY: "nope" };
    const unrouted = hostInit("pi", [], undefined, env);
    expect(unrouted.env).toEqual({ BRAIN_LOCAL_MODEL_URL: "http://m:8000/v1" });
    expect(unrouted.secrets).toEqual({ BRAIN_LOCAL_MODEL_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" });
    const routed = hostInit("pi", [], ROUTE, env);
    expect(routed.secrets).toMatchObject({ BRAIN_MODEL_KEY_ROUTE_KEY: "k3" });
    expect(JSON.stringify(routed)).not.toMatch(/k4|nope|\/home\/x/u);
  });
});

describe("the attempt's state directory", () => {
  it("holds a saved conversation past the attempt, places it for a resume, and goes with an attempt that saved none", () => {
    const digestHex = "ab".repeat(32);
    mkdirSync(join(root, "old", ".pi-agent", "checkpoints"), { recursive: true });
    writeFileSync(join(root, "old", ".pi-agent", "checkpoints", `${digestHex}.jsonl`), "{}\n");
    const dir = prepareAttemptState(root, "new", { artifactId: "a", digest: `sha256:${digestHex}`, bytes: 3, mediaType: "application/jsonl", classification: "internal" } as never);
    expect(readFileSync(join(dir, ".pi-agent", "checkpoints", `${digestHex}.jsonl`), "utf8")).toBe("{}\n");
    // A resume of a conversation this runner does not hold places nothing: the engine refuses it, as in-process.
    const none = prepareAttemptState(root, "other", { artifactId: "a", digest: digest("c"), bytes: 1, mediaType: "x", classification: "internal" } as never);
    expect(existsSync(join(none, ".pi-agent"))).toBe(false);
  });
});
