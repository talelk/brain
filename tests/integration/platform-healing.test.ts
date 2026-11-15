import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDraining, setDraining } from "../../apps/governor/src/modules/jobs/index";
import { launcherHealthCheck } from "../../apps/runner/src/supervisor";
import { EXIT_BLOCK, EXIT_PASS, EXIT_SKIPPED, gate } from "../../scripts/standing-tests/gate";
import { allTasks, decideGate, fingerprint, runStandingTests, scoreAnswer } from "../../scripts/standing-tests/lib";
import { fixtureTasks, replayedServerTasks } from "../../scripts/standing-tests/fixtures";
import { FAILS_BEFORE_RESTART, MAX_RESTARTS_PER_HOUR, round, type CheckSpec, type WatchdogState } from "../../scripts/watchdog/host-watchdog";
import { tempBrain } from "../helpers";

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

/** An OpenAI-compatible endpoint that serves one model and answers every task with the same words. */
async function fakeModel(answer: string): Promise<string> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "fake-model" }] })); return; }
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 50 } })));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
}
const baselineFile = (rate: number): string => {
  const file = join(mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "standing-baseline-")), "baseline.json");
  writeFileSync(file, JSON.stringify({ firstPassRate: rate, model: "fake-model", recordedAt: "2026-11-01T00:00:00.000Z" }));
  return file;
};

describe("standing test set (backlog row 78)", () => {
  it("has about 40 fixture tasks and 5 replayed server tasks, each with a real check", () => {
    expect(fixtureTasks.length).toBeGreaterThanOrEqual(38);
    expect(replayedServerTasks).toHaveLength(5);
    expect(new Set(allTasks().map((task) => task.id)).size).toBe(allTasks().length);
    for (const task of allTasks()) expect(Object.keys(task.check).length, task.id).toBeGreaterThan(0);
  });

  it("scores answers deterministically and reports first-pass success, attempts, tokens and time", async () => {
    expect(scoreAnswer('{"category": "billing"}', { jsonKeys: ["category"], all: ["billing"] })).toEqual([]);
    expect(scoreAnswer("billing", { jsonKeys: ["category"] })).toEqual(["not a JSON object"]);
    expect(scoreAnswer("I could not see any containers", { all: ["demo-worker"], none: ["could not"] })).toHaveLength(2);
    const task = fixtureTasks.find((entry) => entry.id === "calc-02")!;
    let calls = 0;
    const report = await runStandingTests(async () => ({ text: calls++ === 0 ? "about 300" : "360", tokens: 10 }), "fake-model", [task]);
    // Wrong the first time, right the second: passed, but not first pass.
    expect(report).toMatchObject({ total: 1, firstPass: 0, firstPassRate: 0, passed: 1, attempts: 2, tokens: 20 });
    expect(report.fingerprint).toBe(fingerprint("fake-model"));
    expect(fingerprint("another-model")).not.toBe(fingerprint("fake-model"));
  });

  it("blocks a deploy only for a drop of more than 10 points", () => {
    const baseline = { firstPassRate: 0.9, model: "m", recordedAt: "x" };
    expect(decideGate({ firstPassRate: 0.8 }, baseline).block).toBe(false);
    expect(decideGate({ firstPassRate: 0.79 }, baseline).block).toBe(true);
    expect(decideGate({ firstPassRate: 0.95 }, baseline).block).toBe(false);
    expect(decideGate({ firstPassRate: 0.2 }, undefined).block).toBe(false);
  });

  it("the deploy gate skips (exit 3) when no model is reachable, never fails", async () => {
    const lines: string[] = [];
    expect(await gate({ BRAIN_LOCAL_MODEL_URL: "http://127.0.0.1:1/v1", BRAIN_LOCAL_MODEL_ID: "fake-model" }, fetch, baselineFile(0.9), (line) => lines.push(line))).toBe(EXIT_SKIPPED);
    expect(lines.join("\n")).toContain("skipped");
    expect(EXIT_SKIPPED).toBe(3);
    // A model that answers but does not serve the configured model is not "reachable" either.
    const url = await fakeModel("x");
    expect(await gate({ BRAIN_LOCAL_MODEL_URL: url, BRAIN_LOCAL_MODEL_ID: "another-model" }, fetch, baselineFile(0.9), () => undefined)).toBe(EXIT_SKIPPED);
  });

  it("the deploy gate runs the set against a model endpoint: exit 1 on a drop of more than 10 points, 0 otherwise", async () => {
    const url = await fakeModel("I cannot observe that.");
    const env = { BRAIN_LOCAL_MODEL_URL: url, BRAIN_LOCAL_MODEL_ID: "fake-model" };
    const lines: string[] = [];
    expect(await gate(env, fetch, baselineFile(0.95), (line) => lines.push(line))).toBe(EXIT_BLOCK);
    expect(lines.join("\n")).toContain("first-pass success");
    expect(lines.join("\n")).toContain("blocked");
    expect(await gate(env, fetch, baselineFile(0.0), () => undefined)).toBe(EXIT_PASS);
    expect(await gate(env, fetch, join(tmpdirOf(), "no-such-baseline.json"), () => undefined)).toBe(EXIT_PASS);
  });
});
const tmpdirOf = (): string => process.env["TMPDIR"] ?? "/tmp";

describe("host watchdog (heal below the application)", () => {
  const checks: CheckSpec[] = [
    { name: "launcher", kind: "unix-http", target: "/run/launcher.sock", restart: "unit:brain-launcher.service", alsoRestart: ["unit:brain-runner-agents.service"] },
    { name: "proxy", kind: "http", target: "http://x/health", restart: "container:tdai-memory-proxy" },
  ];
  const fresh: WatchdogState = { failures: {}, restarts: {} };

  it("restarts only what keeps failing, and the runners with a dead launcher", async () => {
    const down = new Set(["launcher"]);
    const restarted: string[] = [];
    const probe = async (spec: CheckSpec) => !down.has(spec.name);
    const restart = async (what: string) => { restarted.push(what); return true; };
    let state = (await round(checks, fresh, probe, restart, 1000)).state;
    expect(restarted).toEqual([]); // one miss is not an outage
    expect(FAILS_BEFORE_RESTART).toBe(2);
    const second = await round(checks, state, probe, restart, 2000);
    expect(restarted).toEqual(["unit:brain-launcher.service", "unit:brain-runner-agents.service"]);
    expect(second.restarted).toContain("launcher");
    expect(second.healthy).toEqual(["proxy"]);
    // Healed: the failure count starts over.
    down.clear();
    state = (await round(checks, second.state, probe, restart, 3000)).state;
    expect(state.failures).toEqual({ launcher: 0, proxy: 0 });
  });

  it("gives up after three restarts in an hour and says so, then tries again once the hour has passed", async () => {
    const restarted: string[] = [];
    const probe = async () => false;
    const restart = async (what: string) => { restarted.push(what); return true; };
    let state = fresh;
    for (let pass = 1; pass <= 2 * (MAX_RESTARTS_PER_HOUR + 1); pass++) state = (await round([checks[1]!], state, probe, restart, pass * 60_000)).state;
    expect(restarted).toHaveLength(MAX_RESTARTS_PER_HOUR);
    const stuck = await round([checks[1]!], state, probe, restart, 9 * 60_000);
    expect(stuck.gaveUp).toEqual(["proxy"]);
    const later = await round([checks[1]!], stuck.state, probe, restart, 9 * 60_000 + 3_700_000);
    expect(later.restarted).toEqual(["proxy"]);
  });

  it("never restarts a name that is not a plain unit or container name", async () => {
    const { hostRestart } = await import("../../scripts/watchdog/host-watchdog");
    expect(await hostRestart("unit:brain-launcher.service; rm -rf /")).toBe(false);
    expect(await hostRestart("shell:anything")).toBe(false);
  });
});

describe("runner reports its launcher (health below the application)", () => {
  it("is healthy without a launcher, degraded on the first miss and unhealthy on the second, healthy again when it answers", async () => {
    expect(await launcherHealthCheck({}, async () => { throw new Error("no"); })()).toBe("healthy");
    let up = false;
    const check = launcherHealthCheck({ BRAIN_LAUNCHER_SOCKET: "/run/launcher.sock" }, async () => { if (!up) throw new Error("down"); return { docker: true }; });
    expect(await check()).toBe("degraded");
    expect(await check()).toBe("unhealthy");
    up = true;
    expect(await check()).toBe("healthy");
    const noDocker = launcherHealthCheck({ BRAIN_LAUNCHER_SOCKET: "/run/launcher.sock" }, async () => ({ docker: false }));
    expect(await noDocker()).toBe("degraded");
  });

  it("a launcher whose Docker answers but whose container image was never built is not usable: degraded, then unhealthy, healthy once built", async () => {
    let missing: string[] = ["brain-sandbox-evaluator"];
    const check = launcherHealthCheck({ BRAIN_LAUNCHER_SOCKET: "/run/launcher.sock" }, async () => ({ docker: true, missingImages: missing }));
    expect(await check()).toBe("degraded");
    expect(await check()).toBe("unhealthy");
    missing = [];
    expect(await check()).toBe("healthy");
  });

  it("the engine image counts only for a runner set up for engine sandboxes (ADR 0067): without one it still runs tools and the fixture", async () => {
    const probe = async () => ({ docker: true, missingImages: ["brain-sandbox-engine"] });
    expect(await launcherHealthCheck({ BRAIN_LAUNCHER_SOCKET: "/run/launcher.sock" }, probe)()).toBe("healthy");
    const configured = launcherHealthCheck({ BRAIN_LAUNCHER_SOCKET: "/run/launcher.sock", BRAIN_RUNNER_ENGINE_STATE_DIR: "/engine-state" }, probe);
    expect(await configured()).toBe("degraded");
    expect(await configured()).toBe("unhealthy");
  });
});

describe("drain for deploys (scripts/drain-live.mjs)", () => {
  it("turns drain on and off in the live control database, which the Governor reads, and waits for running attempts", () => {
    const { brain, dir } = tempBrain();
    try {
      const drain = (...args: string[]) => {
        const result = spawnSync(process.execPath, ["scripts/drain-live.mjs", ...args], { env: { ...process.env, BRAIN_DATA_DIR: dir }, encoding: "utf8" });
        return { code: result.status, out: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {} };
      };
      expect(drain("status").out).toMatchObject({ supported: true, draining: false, runningAttempts: 0 });
      expect(drain("on")).toMatchObject({ code: 0, out: { draining: true } });
      expect(isDraining(brain.store)).toBe(true);
      expect(drain("wait", "5")).toMatchObject({ code: 0, out: { idle: true, draining: true } });
      expect(drain("off").out).toMatchObject({ draining: false });
      expect(isDraining(brain.store)).toBe(false);
      // The Governor's own command and the script agree on one flag.
      setDraining(brain.store, "owner", true);
      expect(drain("status").out).toMatchObject({ draining: true });
    } finally { brain.close(); }
  });
});
