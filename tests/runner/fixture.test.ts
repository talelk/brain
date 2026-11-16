import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue, NativeLevel } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { FixtureEngine, fixtureCommands } from "../../apps/runner/src/engines/fixture";
import type { EngineEvent, EngineSessionSpec, EngineTool } from "../../apps/runner/src/engines/port";
import { tempDir, writeFiles } from "./git-repo";

const TOOL: EngineTool = { name: "task.note", description: "Writes a note.", inputSchema: { type: "object" }, effect: "read" };

/** Runs one fixture session and returns its events; tool requests are answered by `answer`. */
async function session(options: { prompt?: string; task: string; native?: NativeLevel; tools?: EngineTool[]; answer?: (tool: string, input: JsonValue) => string; workDir?: string }): Promise<{ events: EngineEvent[]; text: string; dir: string; out: string }> {
  const dir = options.workDir ?? tempDir("fixture-work");
  const out = tempDir("fixture-out");
  const engine = new FixtureEngine();
  const spec: EngineSessionSpec = {
    attemptId: "a1", instructions: options.prompt ?? "", task: options.task, model: { baseUrl: "http://unused", token: "", name: "main" }, native: options.native ?? "none",
    workDir: dir, outDir: out, stateDir: out, tools: options.tools ?? [], limits: { timeoutMs: 10_000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 20 },
  };
  const signal = new AbortController().signal;
  const events: EngineEvent[] = [];
  await engine.start(spec, signal);
  for await (const event of engine.events(signal)) {
    events.push(event);
    if (event.kind === "tool.request") await engine.toolResult(event.callId, options.answer?.(event.tool, event.input) ?? "{}");
  }
  return { events, dir, out, text: events.filter((event) => event.kind === "text" && event.channel === "assistant").map((event) => (event as { text: string }).text).join("") };
}

describe("the fixture script language", () => {
  it("reads commands from lines that start with FIXTURE, scoped by kind and round", () => {
    const text = ["Write the note.", "FIXTURE @work write a.md hello", "  FIXTURE @check #1 json {\"pass\": false}", "- FIXTURE @check #2+ json {\"pass\": true}", "FIXTURE #3 reply third round", "FIXTURE reply always", "not a FIXTURE line"].join("\n");
    expect(fixtureCommands(text, "work", 1)).toEqual([{ name: "write", args: "a.md hello" }, { name: "reply", args: "always" }]);
    expect(fixtureCommands(text, "check", 1)).toEqual([{ name: "json", args: '{"pass": false}' }, { name: "reply", args: "always" }]);
    expect(fixtureCommands(text, "check", 4)).toEqual([{ name: "json", args: '{"pass": true}' }, { name: "reply", args: "always" }]);
    expect(fixtureCommands(text, "work", 3).map((command) => command.args)).toEqual(["a.md hello", "third round", "always"]);
  });

  it("answers with the reply of the script, prompt lines before task lines, the last one winning", async () => {
    const ran = await session({ prompt: "FIXTURE reply from the prompt", task: "[work attempt, round 1]\nFIXTURE reply from the task\\nsecond line" });
    expect(ran.text).toBe("from the task\nsecond line");
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "completed" });
  });

  it("gives a JSON answer that depends on the round", async () => {
    const goal = 'FIXTURE @check #1 json {"pass": false, "score": 0.2, "findings": "say more"}\nFIXTURE @check #2+ json {"pass": true, "score": 0.9, "findings": "fine"}';
    expect(JSON.parse((await session({ task: `[check attempt, round 1]\n${goal}` })).text)).toEqual({ pass: false, score: 0.2, findings: "say more" });
    expect(JSON.parse((await session({ task: `[check attempt, round 2]\n${goal}` })).text)).toEqual({ pass: true, score: 0.9, findings: "fine" });
  });

  it("has an answer of the right form for every kind when the script gives none", async () => {
    expect((await session({ task: "[work attempt, round 1]\n# Goal\nShip it" })).text).toBe("fixture: done");
    expect(JSON.parse((await session({ task: "[check attempt, round 1]" })).text)).toEqual({ pass: true, score: 1, findings: "fixture check" });
    expect(JSON.parse((await session({ task: "[judge attempt, round 1]\n\n# The candidates\n## Candidate attempt-7 (by agent worker)\n## Candidate attempt-8 (by agent worker)" })).text)).toEqual({ keep: "attempt-7", findings: "fixture judge" });
    const plan = JSON.parse((await session({ task: "[plan attempt, round 1]\n\n# Goal\nShip the feature\n\nDetails.\n\n# This workspace\n## Agents\n- planner: plans\n- worker: works\n## Tools\n- task.note: notes" })).text) as { tasks: Array<{ agent: string; goal: string; after: string[] }> };
    expect(plan.tasks).toEqual([{ title: "Ship the feature", goal: "Ship the feature", agent: "worker", after: [] }]);
  });

  it("edits, reads and deletes files in the working copy as native tool calls", async () => {
    const dir = tempDir("fixture-work");
    writeFiles(dir, { "old.txt": "old\n", "kept.txt": "kept\n" });
    const ran = await session({ native: "all", workDir: dir, task: "[work attempt, round 2]\nFIXTURE write src/new.txt round %round%\\n\nFIXTURE delete old.txt\nFIXTURE read kept.txt\nFIXTURE out report.md # Report\nFIXTURE reply read: %last%" });
    expect(readFileSync(join(dir, "src/new.txt"), "utf8")).toBe("round 2\n");
    expect(existsSync(join(dir, "old.txt"))).toBe(false);
    expect(readFileSync(join(ran.out, "report.md"), "utf8")).toBe("# Report");
    expect(ran.text).toBe("read: kept\n");
    expect(ran.events.filter((event) => event.kind === "native.call")).toEqual([
      { kind: "native.call", callId: "native-1", name: "write", input: { path: "src/new.txt", content: "round 2\n" } },
      { kind: "native.call", callId: "native-2", name: "delete", input: { path: "old.txt" } },
      { kind: "native.call", callId: "native-3", name: "read", input: { path: "kept.txt" } },
    ]);
    expect(ran.events.filter((event) => event.kind === "native.result").map((event) => (event as { ok: boolean }).ok)).toEqual([true, true, true]);
  });

  it("refuses a native tool the agent's level does not include, and a path outside the working copy", async () => {
    const readOnly = await session({ native: "read", task: "FIXTURE write a.txt x" });
    expect(readOnly.events.at(-1)).toEqual({ kind: "stopped", reason: "error", detail: 'the script uses write but the agent\'s native tools are "read"' });
    const outside = await session({ native: "all", task: "FIXTURE write ../outside.txt x" });
    expect(outside.events.find((event) => event.kind === "native.result")).toMatchObject({ ok: false, output: "the script's write path ../outside.txt leaves the directory" });
  });

  it("calls a workspace tool as a model would and can quote its answer", async () => {
    const asked: Array<[string, JsonValue]> = [];
    const ran = await session({ tools: [TOOL], task: 'FIXTURE tool task.note {"text": "hello"}\nFIXTURE reply the tool said %last%', answer: (tool, input) => { asked.push([tool, input]); return '{"id":"note-1"}'; } });
    expect(asked).toEqual([["task.note", { text: "hello" }]]);
    expect(ran.text).toBe('the tool said {"id":"note-1"}');
  });

  it("fails with the reason of the script, and reports the usage the script adds", async () => {
    const ran = await session({ task: "FIXTURE usage 1000 200 50\nFIXTURE fail the model went away" });
    expect(ran.events.at(-1)).toEqual({ kind: "stopped", reason: "error", detail: "the model went away" });
    expect(ran.events.filter((event) => event.kind === "usage").at(-1)).toMatchObject({ outputTokens: 200, microUsd: 50, turns: 1 });
  });

  it("stops when the session is cancelled during a sleep", async () => {
    const engine = new FixtureEngine();
    const abort = new AbortController();
    const out = tempDir("fixture-out");
    await engine.start({ attemptId: "a1", instructions: "", task: "FIXTURE sleep 60000\nFIXTURE reply never", model: { baseUrl: "", token: "", name: "" }, native: "none", outDir: out, stateDir: out, tools: [], limits: { timeoutMs: 1000, maxTokens: 1, maxMicroUsd: 0, maxTurns: 1 } }, abort.signal);
    setTimeout(() => abort.abort(), 20);
    const events: EngineEvent[] = [];
    for await (const event of engine.events(new AbortController().signal)) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: "cancelled" });
  });
});
