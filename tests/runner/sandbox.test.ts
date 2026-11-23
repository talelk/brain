import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import { serveEngineHost } from "../../apps/runner/src/engines/sandbox-host";
import type { EngineChannel, EngineSandboxRequest } from "../../apps/runner/src/engines/sandboxed";
import type { Launcher } from "../../apps/runner/src/launcher-client";
import { bareRepository } from "./git-repo";
import { ECHO_SCRIPT, runnerWorld } from "./world";

/**
 * A launcher without Docker: `openEngine` starts the real engine host in this process, serving the fixture under the name of the engine
 * asked for, and speaks the real frame protocol with the runner. The only thing a container would add is the mounts, so the paths the
 * runner sends (`/work`, `/out`, `/state`) are rewritten to the attempt's folders on their way in.
 */
function inProcessLauncher(attemptsRoot: () => string): Launcher & { opened: EngineSandboxRequest[]; closed: number } {
  const launcher = {
    opened: [] as EngineSandboxRequest[], closed: 0,
    health: async () => ({ docker: true, missingImages: [] }),
    runTool: async () => { throw new Error("no tool sandbox in this test"); },
    hostCommand: async () => { throw new Error("no host commands in this test"); },
    openEngine: async (request: EngineSandboxRequest): Promise<EngineChannel> => {
      launcher.opened.push(request);
      const dir = join(attemptsRoot(), request.attemptId);
      const input = new PassThrough();
      const output = new PassThrough({ encoding: "utf8" });
      void serveEngineHost(input, (text) => { output.write(text); }, () => new FixtureEngine()).then(() => output.end());
      return {
        send: async (line) => { input.write(line.replace(/"\/(work|out|state)(?=["/])/gu, (_all, name: string) => `"${dir}/${name}`)); },
        lines: () => (async function* () { let rest = ""; for await (const chunk of output) { rest += String(chunk); const lines = rest.split("\n"); rest = lines.pop() ?? ""; yield* lines; } })(),
        close: async () => { launcher.closed += 1; input.end(); },
      };
    },
  };
  return launcher;
}

describe("an engine in its sandbox", () => {
  it("runs setup and the session over the sandbox channel, with the working copy mounted for the agent's native level", async () => {
    let root = "";
    const launcher = inProcessLauncher(() => root);
    const { gov, runner, stateDir } = await runnerWorld({ engines: ["pi"], launcher, unsandboxedForTests: false });
    root = join(stateDir, "attempts");
    // An engine that runs sandboxed may be given native tools, so the runner states the capability.
    expect(gov.hellos[0]).toMatchObject({ engines: ["pi"], capabilities: ["bash", "native-tools"] });
    const origin = bareRepository({ "a.txt": "a\n", ".gitignore": "*.log\n" });
    const offer = gov.offer({
      agent: { engines: ["pi"], native: "all" }, model: { gatewayUrl: "https://Brain.Example.test:8443/model/v1", route: "main", contextTokens: 200_000, compactAt: 0.7 },
      projects: [{ name: "app", repo: origin.repo, branch: "main", access: "write", network: ["registry.npmjs.org", "*.example.test", "*"], setup: "echo installed > setup.log" }],
      tools: [gov.tool("task.note", { runs: "brain", inputSchema: { type: "object" } })],
      task: { goal: 'FIXTURE read app/setup.log\nFIXTURE write app/b.txt b\\n\nFIXTURE tool task.note {"text": "hello"}\nFIXTURE reply done: %last%' },
    });
    await runner.runOnce();
    expect(launcher.opened).toEqual([{ engine: "pi", attemptId: offer.attemptId, requestId: `engine-${offer.attemptId}-1`, cpuMillicores: 1000, memoryMb: 1024, work: "rw", egressHosts: ["brain.example.test:8443", "registry.npmjs.org", "*"] }]);
    expect(launcher.closed).toBe(1);
    const done = gov.completions.get(offer.attemptId)!;
    expect(done).toMatchObject({ outcome: "succeeded", engine: "pi", result: 'done: {"ok":true}' });
    expect(gov.eventsOf(offer.attemptId, "native.result")[0]).toMatchObject({ ok: true, output: "installed\n" });
    expect(gov.eventsOf(offer.attemptId, "status").map((event) => event.detail)).toContain("the egress proxy grants exact host names only, so these are not reachable: *.example.test");
    expect(Buffer.from(gov.artifacts.find((artifact) => artifact.kind === "patch")!.bytes).toString("utf8")).toContain("+b");
  });

  it("mounts the working copy read-only for a reading agent, not at all for one without native tools, and runs no setup for either", async () => {
    let root = "";
    const launcher = inProcessLauncher(() => root);
    const { gov, runner, stateDir } = await runnerWorld({ engines: ["pi"], launcher, unsandboxedForTests: false });
    root = join(stateDir, "attempts");
    const origin = bareRepository({ "a.txt": "a\n" });
    const projects = [{ name: "app", repo: origin.repo, branch: "main", access: "read" as const, network: [], setup: "exit 9" }];
    const reader = gov.offer({ agent: { engines: ["pi"], native: "read" }, projects, task: { goal: "FIXTURE read app/a.txt\nFIXTURE reply %last%" } });
    const talker = gov.offer({ agent: { engines: ["pi"], native: "none" }, projects, task: { goal: "FIXTURE reply nothing to read" } });
    await runner.runOnce();
    await runner.runOnce();
    expect(launcher.opened.map((request) => request.work)).toEqual(["ro", "none"]);
    expect(gov.completions.get(reader.attemptId)).toMatchObject({ outcome: "succeeded", result: "a\n" });
    expect(gov.completions.get(talker.attemptId)).toMatchObject({ outcome: "succeeded", result: "nothing to read" });
  });

  it("fails the attempt as the runner's problem when the sandbox cannot start, and never runs the engine in the runner", async () => {
    const launcher: Launcher = { health: async () => ({ docker: true, missingImages: [] }), runTool: async () => { throw new Error("unused"); }, hostCommand: async () => { throw new Error("unused"); }, openEngine: async () => { throw new Error("engine sandbox create failed 503: docker run failed") ; } };
    const { gov, runner } = await runnerWorld({ engines: ["pi"], launcher, unsandboxedForTests: false });
    const offer = gov.offer({ agent: { engines: ["pi"] }, tools: [gov.tool("echo.back", { script: ECHO_SCRIPT })] });
    await runner.runOnce();
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "failed", failure: { reason: "runner", infrastructure: true, detail: "engine sandbox create failed 503: docker run failed" } });
  });

  it("does not state native tools while the engine image is missing: the engine then runs in the runner, with its own tools off", async () => {
    const launcher: Launcher = { health: async () => ({ docker: true, missingImages: ["brain-sandbox-engine"] }), runTool: async () => { throw new Error("unused"); }, hostCommand: async () => { throw new Error("unused"); }, openEngine: async () => { throw new Error("unused"); } };
    const { gov } = await runnerWorld({ engines: ["pi"], launcher, capabilities: ["bash", "native-tools"] });
    expect(gov.hellos[0]).toMatchObject({ engines: ["pi"], capabilities: ["bash"] });
  });
});
