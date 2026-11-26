import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JobOffer, OfferTool } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { pickEngine } from "../../apps/runner/src/attempt";
import { engineToolName, toolNameNote } from "../../apps/runner/src/engines/tool-calls";
import { composeTask } from "../../apps/runner/src/task-text";
import { ToolCalls } from "../../apps/runner/src/tools/calls";
import { scriptResult, secretEnvName } from "../../apps/runner/src/tools/script";
import { ECHO_SCRIPT, markerScript, runnerWorld } from "./world";

const SCHEMA = { type: "object", properties: { container: { type: "string" }, lines: { type: "integer" }, mode: { type: "string", enum: ["fast", "slow"] }, tags: { type: "array", items: { type: "string" } } }, required: ["container"], additionalProperties: false };

describe("tool input validation", () => {
  const tool = { name: "host.logs", inputSchema: SCHEMA } as unknown as OfferTool;
  const calls = new ToolCalls({ offer: {} as JobOffer, client: {} as never, launcher: undefined, attemptDir: "", emit: () => undefined, syncState: async () => undefined, baseCommits: () => ({}), stateCommits: () => ({}), leaseLost: () => undefined, unsandboxedForTests: false, signal: new AbortController().signal });

  it("accepts an input that fits the tool's inputs", () => {
    expect(calls.inputProblem(tool, { container: "web", lines: 100, mode: "fast", tags: ["a"] })).toBeUndefined();
    expect(calls.inputProblem(tool, { container: "web" })).toBeUndefined();
  });

  it("says what is wrong with one that does not", () => {
    expect(calls.inputProblem(tool, {})).toContain('"container" is required');
    expect(calls.inputProblem(tool, { container: 7 })).toContain('"container" must be of type string');
    expect(calls.inputProblem(tool, { container: "web", lines: 1.5 })).toContain('"lines" must be of type integer');
    expect(calls.inputProblem(tool, { container: "web", mode: "medium" })).toContain('"mode" must be one of');
    expect(calls.inputProblem(tool, { container: "web", extra: true })).toContain('"extra" is not an input');
    expect(calls.inputProblem(tool, "web")).toContain("the input must be a JSON object");
  });

  it("records a call with a wrong input as failed and never runs the tool", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    const offer = gov.offer({ tools: [gov.tool("deploy.mark", { script: markerScript(stateDir, "ran"), inputSchema: SCHEMA })], task: { goal: 'FIXTURE tool deploy.mark {"lines": 5}\nFIXTURE reply told: %last%' } });
    await runner.runOnce();
    expect(existsSync(join(stateDir, "ran"))).toBe(false);
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "failed", output: { error: "The input does not fit the tool's inputs: \"container\" is required" } });
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: expect.stringContaining("is required") as string });
  });
});

describe("declared outputs", () => {
  const declared = { type: "object", properties: { state: { type: "string" } }, required: ["state"] };

  it("holds a script's result to the outputs the tool declares, and allows what it does not declare", () => {
    const run = (stdout: string) => scriptResult({ exitCode: 0, stdout, stderr: "", timedOut: false }, [], declared);
    expect(run('{"state": "running", "since": 3}')).toEqual({ ok: true, output: { state: "running", since: 3 } });
    expect(run('{"since": 3}')).toMatchObject({ ok: false, output: { error: "the tool's result does not fit its outputs: \"state\" is required" } });
    expect(run('{"state": 4}')).toMatchObject({ ok: false, output: { error: expect.stringContaining('"state" must be of type string') as string } });
  });

  it("tells the agent of a step what to answer, checks the answer, and lets it say it is blocked", async () => {
    const { gov, runner } = await runnerWorld();
    const schema = { type: "object", properties: { healthy: { type: "boolean" } }, required: ["healthy"] };
    const asked = (goal: string) => gov.offer({ task: { goal, outputSchema: schema } });
    const good = asked('FIXTURE json {"healthy": false}');
    const wrong = asked("FIXTURE reply all is well");
    const blocked = asked("FIXTURE reply BLOCKED: there is no runbook");
    const unsaid = asked("Check the services.");
    for (let at = 0; at < 4; at++) await runner.runOnce();
    expect(gov.completions.get(good.attemptId)).toMatchObject({ outcome: "succeeded", output: { healthy: false } });
    expect(gov.completions.get(wrong.attemptId)).toMatchObject({ outcome: "failed", failure: { reason: "engine", detail: expect.stringContaining("is not the required JSON") as string } });
    expect(gov.completions.get(blocked.attemptId)).toMatchObject({ outcome: "succeeded", result: "BLOCKED: there is no runbook" });
    // With nothing said, the fixture answers the plainest JSON that fits, so a Play with outputs runs with no model.
    expect(gov.completions.get(unsaid.attemptId)).toMatchObject({ outcome: "succeeded", output: { healthy: true } });
  });
});

describe("script tools", () => {
  it("reads a script's exit as the pack convention says", () => {
    const run = (exitCode: number, stdout: string, stderr = "", timedOut = false) => scriptResult({ exitCode, stdout, stderr, timedOut }, ["s3cret-value"]);
    expect(run(0, '{"status": 200}')).toEqual({ ok: true, output: { status: 200 } });
    expect(run(2, '{"error": "url must be https"}')).toEqual({ ok: false, output: { error: "url must be https" } });
    expect(run(1, "", "boom s3cret-value")).toEqual({ ok: false, output: { error: "the tool ended with exit code 1", stderr: "boom [redacted]" } });
    expect(run(0, "not json")).toEqual({ ok: false, output: { error: "the tool printed no JSON result", stdout: "not json" } });
    expect(run(0, '{"token": "s3cret-value"}')).toEqual({ ok: true, output: { token: "[redacted]" } });
    // A value with a newline and a quote reads differently inside a JSON string: it is removed there too.
    const multiline = scriptResult({ exitCode: 0, stdout: JSON.stringify({ key: "line one\n\"two\"" }), stderr: "", timedOut: false }, ['line one\n"two"']);
    expect(multiline).toEqual({ ok: true, output: { key: "[redacted]" } });
    expect(run(-1, "", "", true)).toEqual({ ok: false, output: { error: "the tool ran longer than its timeout and was stopped" } });
  });

  it("leases a tool's declared secrets for the call, passes them as environment variables and keeps them out of the record", async () => {
    expect(secretEnvName("deploy-key")).toBe("BRAIN_SECRET_DEPLOY_KEY");
    const { gov, runner } = await runnerWorld();
    gov.secrets["deploy-key"] = "s3cret-value";
    const script = '#!/usr/bin/env bash\ncat > /dev/null\nprintf \'{"saw": "%s", "length": %s}\' "$BRAIN_SECRET_DEPLOY_KEY" "$(printf %s "$BRAIN_SECRET_DEPLOY_KEY" | wc -c)"\n';
    const offer = gov.offer({ tools: [gov.tool("deploy.show", { script, secrets: ["deploy-key"] })], task: { goal: "FIXTURE tool deploy.show {}\nFIXTURE reply %last%" } });
    await runner.runOnce();
    expect(gov.secretRequests).toEqual([{ fence: 1, name: "deploy-key", use: { tool: "deploy.show" } }]);
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "succeeded", output: { saw: "[redacted]", length: 12 } });
    expect(JSON.stringify([...gov.events.values()]) + gov.completions.get(offer.attemptId)!.result).not.toContain("s3cret-value");
  });

  it("refuses to run a script without a launcher outside the tests' own switch", async () => {
    const { gov, runner } = await runnerWorld({ unsandboxedForTests: false });
    const offer = gov.offer({ tools: [gov.tool("echo.back", { script: ECHO_SCRIPT })], task: { goal: "FIXTURE tool echo.back {}" } });
    await runner.runOnce();
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "failed", output: { error: "this runner has no launcher, so it cannot run a tool in a sandbox; the call was not made" } });
  });

  it("runs a host command through the launcher with the tool's inputs as named arguments", async () => {
    const ran: unknown[] = [];
    const launcher = {
      health: async () => ({ docker: false, missingImages: [] }), runTool: async () => { throw new Error("unused"); }, openEngine: async () => { throw new Error("unused"); },
      hostCommand: async (...args: unknown[]) => { ran.push(args); return { exitCode: 0, stdout: "web  Up 3 hours\n", stderr: "", timedOut: false }; },
    };
    const { gov, runner } = await runnerWorld({ launcher });
    const offer = gov.offer({ tools: [gov.tool("host.logs", { hostCommand: "host.logs", inputSchema: SCHEMA })], task: { goal: 'FIXTURE tool host.logs {"container": "web", "lines": 100}\nFIXTURE reply %last%' } });
    await runner.runOnce();
    expect(ran).toEqual([["host.logs", { container: "web", lines: "100" }, "read", `${offer.attemptId}-call-1`, expect.any(AbortSignal)]]);
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: "web  Up 3 hours" });
  });
});

describe("choosing an engine and naming tools", () => {
  const OPENAI = { provider: "openai-compatible", route: "open", contextTokens: 200_000, compactAt: 0.7 } as const;
  const ANTHROPIC = { provider: "anthropic", route: "opus", contextTokens: 200_000, compactAt: 0.7 } as const;
  const offer = (engines: string[], native: "none" | "read" | "all", routes: JobOffer["model"]["routes"] = [OPENAI, ANTHROPIC]) => ({ agent: { engines, native }, model: { gatewayUrl: "http://localhost/model/v1", routes } }) as unknown as JobOffer;

  it("takes only an engine that speaks the API of a model the workspace has, and calls that model", () => {
    expect(pickEngine(offer(["pi", "claude"], "none", [ANTHROPIC]), ["pi", "claude"], true)).toEqual({ id: "claude", hosting: "sandboxed", route: ANTHROPIC });
    expect(pickEngine(offer(["pi", "claude"], "none"), ["pi", "claude"], true)).toEqual({ id: "pi", hosting: "sandboxed", route: OPENAI });
    expect(pickEngine(offer(["claude"], "none"), ["claude"], true)).toEqual({ id: "claude", hosting: "sandboxed", route: ANTHROPIC });
    expect(pickEngine(offer(["pi"], "none", [ANTHROPIC]), ["pi"], true)).toBeUndefined();
    // The fixture calls no model, whatever it stands in for.
    expect(pickEngine(offer(["pi"], "none", [ANTHROPIC]), ["fixture"], false, ["pi"])).toEqual({ id: "fixture", hosting: "fixture", route: ANTHROPIC });
  });


  it("takes the first engine of the agent's list that the runner has", () => {
    expect(pickEngine(offer(["pi", "claude"], "none"), ["claude", "fixture"], false)).toEqual({ id: "claude", hosting: "in-process", route: ANTHROPIC });
    expect(pickEngine(offer(["pi"], "none"), ["fixture"], false)).toBeUndefined();
  });

  it("gives native tools only to an engine in a sandbox, or to the fixture", () => {
    expect(pickEngine(offer(["pi"], "all"), ["pi"], false)).toBeUndefined();
    expect(pickEngine(offer(["pi"], "read"), ["pi"], true)).toEqual({ id: "pi", hosting: "sandboxed", route: OPENAI });
    expect(pickEngine(offer(["pi", "fixture"], "all"), ["pi", "fixture"], false)).toEqual({ id: "fixture", hosting: "fixture", route: OPENAI });
  });

  it("where the fixture stands in for an engine, an agent written for that engine runs on the fixture, with no model", async () => {
    expect(pickEngine(offer(["pi", "claude"], "all"), ["fixture"], false, ["pi", "claude"])).toEqual({ id: "fixture", hosting: "fixture", route: OPENAI });
    expect(pickEngine(offer(["opencode"], "none"), ["fixture"], false, ["pi", "claude"])).toBeUndefined();
    const { gov, runner } = await runnerWorld({ fixtureFor: ["pi", "claude"] });
    expect(gov.hellos.at(-1)).toMatchObject({ engines: ["fixture", "pi", "claude"], capabilities: ["bash", "native-tools"] });
    const made = gov.offer({ agent: { engines: ["pi", "claude"], native: "read" }, task: { goal: "Describe the workspace." } });
    await runner.runOnce();
    expect(gov.completions.get(made.attemptId)).toMatchObject({ outcome: "succeeded", engine: "fixture", result: "fixture: done" });
  });

  it("gives a workspace tool a name a model API accepts, apart from the engine's own tools", () => {
    expect(engineToolName("git.open-pr")).toBe("git_open-pr");
    expect(engineToolName("read")).toBe("tool_read");
    // The prompts say `memory.search`; the model is told which name it must call.
    expect(toolNameNote([{ name: "memory.search" }, { name: "plain" }])).toContain("`memory.search` is called `memory_search`");
    expect(toolNameNote([{ name: "plain" }])).toBe("");
  });
});

describe("the task text", () => {
  it("holds everything of the offer the agent is to know, under the same headings every time", async () => {
    const { gov } = await runnerWorld();
    const offer = gov.offer({
      kind: "check", task: { title: "Fix the bug", goal: "Make the test pass.", round: 2, findings: ["The test still fails."] },
      projects: [{ name: "app", repo: "unused", branch: "main", access: "write", network: [] }],
      context: {
        results: [{ taskId: "t0", title: "Investigate", result: "The cause is a typo." }], notes: [{ author: "analyst", text: "Look at line 3.", at: 1 }],
        answers: [{ question: "Which branch?", answer: "main", by: "talel", at: 2 }],
        catalog: { agents: [{ name: "worker", description: "Does the work." }], tools: [{ name: "task.note", description: "Writes a note." }], plays: [{ name: "fix-issue", description: "Fixes an issue." }] },
        review: [{ attemptId: "attempt-9", agent: "developer", result: "Fixed it.", toolCalls: [{ tool: "task.note", effect: "read", input: { text: "done" }, output: { id: "n1" }, outcome: "succeeded" }], files: [], diff: { digest: "sha256:x", bytes: 1 } }],
      },
    });
    const text = composeTask(offer, { work: "/work", out: "/out" }, new Map([["attempt-9", { path: "/work/.brain/attempt-9.patch" }]]));
    expect(text).toContain("# Where you are\n/work/<project> are the project folders");
    // With no project, /work holds nothing that is kept: the agent is told to put its results in /out.
    expect(composeTask({ ...offer, projects: [] }, { work: "/work", out: "/out" })).toContain("/work is empty: this task has no project folder, and a file written there is lost");
    expect(text.replace(/\n\n# Where you are[\s\S]*?(?=\n\n)/u, "")).toBe([
      "[check attempt, round 2]", "# Goal\nFix the bug\n\nMake the test pass.",
      "# Findings of earlier rounds\nThis is round 2. Earlier checks of this task found the following; each point must be dealt with.\n1. The test still fails.",
      "# Results of the tasks this one waits for\n## Investigate (task t0)\nThe cause is a typo.", "# Shared notes\n- analyst: Look at line 3.",
      "# Answers to earlier questions\n- Question: Which branch?\n  Answer (talel): main",
      "# This workspace\n## Agents\n- worker: Does the work.\n## Tools\n- task.note: Writes a note.\n## Plays\n- fix-issue: Fixes an issue.",
      '# What to check\n## Result attempt-9 (by agent developer)\n### Result\nFixed it.\n### Recorded tool calls\n1. task.note (read, succeeded)\n   input: {"text":"done"}\n   output: {"id":"n1"}\n### Changes\nThe changes to the working copy are in the patch file /work/.brain/attempt-9.patch; read it.',
      "# Working copy\n- app: /work/app (branch main)\nFiles to keep as results go in /out.",
      '# Final answer\nReply with one JSON object and nothing else, no code fence:\n{"pass": true, "score": 0.9, "findings": "string"}\nAll three are always there. "score" is from 0 to 1.',
    ].join("\n\n"));
  });
});
