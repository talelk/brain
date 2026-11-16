import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlobRef, OfferProject } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { Runner } from "../../apps/runner/src/runner";
import { buildPatch, parsePatch } from "../../apps/runner/src/working-copy";
import { bareRepository, tempDir } from "./git-repo";
import { ECHO_SCRIPT, markerScript, runnerWorld } from "./world";

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
const project = (repo: string, overrides: Partial<OfferProject> = {}): OfferProject => ({ name: "app", repo, branch: "main", access: "write", network: [], ...overrides });

describe("the runner's session", () => {
  it("enrols once with the token, proves its key at every hello and states what it can run", async () => {
    const { gov, runner, cfg } = await runnerWorld({ capabilities: ["bash", "python3", "native-tools"] });
    expect(readFileSync(join(cfg.stateDir, "runner.key.pem"), "utf8")).toContain("PRIVATE KEY");
    expect(JSON.parse(readFileSync(join(cfg.stateDir, "credential"), "utf8"))).toEqual({ runnerId: runner.runnerId });
    // The fixture can be given native tools, so the runner states the capability itself; the operator's own spelling of it is not doubled.
    expect(gov.hellos[0]).toMatchObject({ runnerId: runner.runnerId, capabilities: ["bash", "python3", "native-tools"], engines: ["fixture"], slots: 1, freeSlots: 1, version: "brain-runner/0.1.0" });
    // A restart has no token: it says hello with the stored credential and key.
    const { enrollToken: _used, ...restarted } = cfg;
    expect((await Runner.connect(restarted)).runnerId).toBe(runner.runnerId);
    expect(gov.hellos).toHaveLength(2);
    await expect(Runner.connect({ ...restarted, stateDir: tempDir("state") })).rejects.toThrow("not enrolled yet");
  });

  it("reports the attempts it runs in a heartbeat and stops the ones the Governor names", async () => {
    const { gov, runner } = await runnerWorld();
    const offer = gov.offer({ task: { goal: "FIXTURE sleep 30000\nFIXTURE reply never" } });
    const running = runner.runOnce();
    await expect.poll(() => gov.acks.has(offer.attemptId)).toBe(true);
    gov.stop = [offer.attemptId];
    await runner.heartbeat();
    expect(gov.heartbeats[0]).toMatchObject({ running: [offer.attemptId], freeSlots: 0 });
    await running;
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "failed", failure: { reason: "stopped", infrastructure: false } });
  });

  it("says nothing more about an attempt whose fence moved", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    const offer = gov.offer({ task: { goal: "FIXTURE sleep 100\nFIXTURE reply too late" } });
    const running = runner.runOnce();
    await expect.poll(() => gov.acks.has(offer.attemptId)).toBe(true);
    gov.fenced.add(offer.attemptId);
    await running;
    expect(gov.completions.has(offer.attemptId)).toBe(false);
    expect(existsSync(join(stateDir, "attempts", offer.attemptId))).toBe(false);
  });

  it("keeps verified blobs on disk and refuses bytes that do not match their digest", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    const prompt = "# Agent\nFIXTURE reply cached";
    gov.offer({ prompt });
    gov.offer({ prompt });
    await runner.runOnce();
    await runner.runOnce();
    expect(gov.blobFetches).toHaveLength(1);
    expect(readFileSync(join(stateDir, "blobs", gov.blobFetches[0]!.slice("sha256:".length)), "utf8")).toBe(prompt);
    const ref = gov.blob("the real bytes");
    gov.blobs.set(ref.digest, new Uint8Array(Buffer.from("other bytes")));
    await expect(runner.client.blob(ref)).rejects.toThrow("do not match its digest");
    expect(runner.client).toBeInstanceOf(GovernorClient);
  });
});

describe("a work attempt", () => {
  it("works in its own working copy and uploads the result, the patch and the files to keep", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    const origin = bareRepository({ "README.md": "# App\n", "src/old.txt": "old\n", ".gitignore": "*.log\n" });
    gov.onBrainTool = () => ({ state: "done", output: { id: "note-1" } });
    const offer = gov.offer({
      prompt: "# Developer\nYou change code.",
      agent: { name: "developer", native: "all", limits: { turns: 20, tokens: 200_000, spendMicroUsd: 0 } },
      projects: [project(origin.repo, { setup: "echo installed > setup.log" })],
      tools: [gov.tool("echo.back", { script: ECHO_SCRIPT, inputSchema: { type: "object" } }), gov.tool("task.note", { runs: "brain", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })],
      task: { goal: ["Add the feature.", "FIXTURE read app/setup.log", "FIXTURE write app/src/new.txt added in round %round%\\n", "FIXTURE delete app/src/old.txt", 'FIXTURE tool echo.back {"n": 1}', 'FIXTURE tool task.note {"text": "added the feature"}', "FIXTURE out report.md # Report\\nDone.", "FIXTURE reply Added src/new.txt and removed src/old.txt."].join("\n") },
    });
    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(false);

    const done = gov.completions.get(offer.attemptId)!;
    expect(done).toMatchObject({ fence: 1, outcome: "succeeded", result: "Added src/new.txt and removed src/old.txt.", engine: "fixture", baseCommits: { app: origin.head() } });
    expect(done.output).toBeUndefined();
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(gov.acks.get(offer.attemptId)).toBe("fixture");

    // The patch: one container, re-appliable per project, with the new and the deleted file and without the ignored one the setup command left.
    const patch = gov.artifacts.find((artifact) => artifact.kind === "patch")!;
    expect(done.workingCopy).toEqual({ digest: patch.digest, bytes: patch.bytes.length });
    const [section] = parsePatch(patch.bytes);
    expect(section!.project).toBe("app");
    expect(patch.mediaType).toBe("text/x-diff");
    expect(text(section!.diff)).toContain("diff --git a/app/src/new.txt b/app/src/new.txt\nnew file mode");
    expect(text(section!.diff)).toContain("+added in round 1");
    expect(text(section!.diff)).toContain("deleted file mode");
    expect(text(section!.diff)).not.toContain("setup.log");
    expect(gov.artifacts.filter((artifact) => artifact.kind === "output").map((artifact) => [artifact.name, artifact.mediaType, text(artifact.bytes)])).toEqual([["report.md", "text/markdown", "# Report\nDone."]]);

    // The record: every native call and every workspace or Brain-run call, in order, with one sequence.
    const events = gov.eventsOf(offer.attemptId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    expect(gov.eventsOf(offer.attemptId, "status").map((event) => event.phase)).toEqual(["setup", "setup", "engine", "upload"]);
    expect(gov.eventsOf(offer.attemptId, "native.call").map((event) => event.name)).toEqual(["read", "write", "delete"]);
    expect(gov.eventsOf(offer.attemptId, "native.result")[0]).toMatchObject({ ok: true, output: "installed\n" });
    expect(gov.eventsOf(offer.attemptId, "tool.call").map((event) => [event.tool, event.effect, event.input])).toEqual([["echo.back", "read", { n: 1 }], ["task.note", "read", { text: "added the feature" }]]);
    expect(gov.eventsOf(offer.attemptId, "tool.result").map((event) => [event.outcome, event.output])).toEqual([["succeeded", { echo: { n: 1 } }], ["succeeded", { id: "note-1" }]]);
    expect(gov.brainCalls).toEqual([{ fence: 1, callId: `${offer.attemptId}-call-2`, tool: "task.note", input: { text: "added the feature" }, baseCommits: done.baseCommits }]);
    expect(gov.eventsOf(offer.attemptId, "usage").at(-1)).toMatchObject(done.usage);
    // Nothing of the attempt stays on the runner but the mirror.
    expect(existsSync(join(stateDir, "attempts", offer.attemptId))).toBe(false);
    expect(existsSync(join(stateDir, "repos", "ws1", "app.git"))).toBe(true);
  });

  it("starts from the patches of the tasks it waits for, and leaves a patch of its own changes only", async () => {
    const { gov, runner } = await runnerWorld();
    const origin = bareRepository({ "a.txt": "a\n" });
    const patchOf = async (goal: string, inherited: BlobRef[] = []): Promise<BlobRef> => {
      const offer = gov.offer({ agent: { native: "all" }, projects: [project(origin.repo)], inheritedPatches: inherited, task: { goal } });
      await runner.runOnce();
      return gov.completions.get(offer.attemptId)!.workingCopy!;
    };
    const first = await patchOf("FIXTURE write app/first.txt first\\n");
    const second = await patchOf("FIXTURE write app/second.txt second\\n");
    const own = await patchOf("FIXTURE read app/first.txt\nFIXTURE write app/own.txt own\\n", [first, second]);
    // The task's patch names its own file and neither of the files it inherited.
    const files = text(gov.blobs.get(own.digest)!);
    expect(files).toContain("b/app/own.txt");
    expect(files).not.toContain("first.txt");
    expect(files).not.toContain("second.txt");
    const offer = gov.offer({ agent: { native: "read" }, projects: [project(origin.repo, { baseCommit: origin.head() })], inheritedPatches: [first, second], workingCopy: own, task: { goal: "FIXTURE read app/first.txt\nFIXTURE read app/second.txt\nFIXTURE read app/own.txt\nFIXTURE reply %last%" } });
    await runner.runOnce();
    const done = gov.completions.get(offer.attemptId)!;
    expect(done).toMatchObject({ outcome: "succeeded", result: "own\n", baseCommits: { app: origin.head() } });
    expect(gov.eventsOf(offer.attemptId, "native.result").map((event) => event.output)).toEqual(["first\n", "second\n", "own\n"]);
    // An agent that cannot write leaves the working copy as it found it: the same patch.
    expect(done.workingCopy).toEqual(own);
  });

  it("fails in setup, naming the paths, when a patch does not apply", async () => {
    const { gov, runner } = await runnerWorld();
    const origin = bareRepository({ "a.txt": "one\n" });
    const patchOf = async (content: string) => { const offer = gov.offer({ agent: { native: "all" }, projects: [project(origin.repo)], task: { goal: `FIXTURE write app/a.txt ${content}\\n` } }); await runner.runOnce(); return gov.completions.get(offer.attemptId)!.workingCopy!; };
    const offer = gov.offer({ projects: [project(origin.repo)], inheritedPatches: [await patchOf("left"), await patchOf("right")] });
    await runner.runOnce();
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "failed", failure: { reason: "setup", infrastructure: false, detail: "the changes of prerequisite 2 of 2 do not apply to project app: conflict in a.txt" }, baseCommits: {} });
  });

  it("carries on when the project's setup command fails, telling the agent and recording it", async () => {
    const { gov, runner } = await runnerWorld();
    const origin = bareRepository({ "a.txt": "one\n" });
    const offer = gov.offer({ agent: { native: "all" }, projects: [project(origin.repo, { setup: "echo no lockfile >&2; exit 3" })] });
    await runner.runOnce();
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded" });
    expect(gov.eventsOf(offer.attemptId, "status").map((event) => event.detail)).toContain("The setup command of project app (echo no lockfile >&2; exit 3) failed with exit code 3: no lockfile");
  });

  it("sends a result that is one JSON object as the structured output too", async () => {
    const { gov, runner } = await runnerWorld();
    const offer = gov.offer({ task: { goal: 'FIXTURE json {"category": "billing", "urgency": "high", "summary": "double charge"}' } });
    await runner.runOnce();
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: '{"category":"billing","urgency":"high","summary":"double charge"}', output: { category: "billing", urgency: "high", summary: "double charge" } });
  });

  it("fails with the engine's reason, and with the numbers when the agent's limits are passed", async () => {
    const { gov, runner } = await runnerWorld();
    const broken = gov.offer({ task: { goal: "FIXTURE fail the model returned nothing" } });
    const quota = gov.offer({ task: { goal: "FIXTURE fail 429 Too Many Requests" } });
    const greedy = gov.offer({ agent: { limits: { turns: 20, tokens: 1000, spendMicroUsd: 0 } }, tools: [gov.tool("echo.back", { script: ECHO_SCRIPT, inputSchema: { type: "object" } })], task: { goal: "FIXTURE usage 5000 0\nFIXTURE tool echo.back {}\nFIXTURE reply done anyway" } });
    const dear = gov.offer({ agent: { limits: { turns: 20, tokens: 1_000_000, spendMicroUsd: 100 } }, tools: [gov.tool("echo.back", { script: ECHO_SCRIPT, inputSchema: { type: "object" } })], task: { goal: "FIXTURE usage 10 10 500\nFIXTURE tool echo.back {}" } });
    for (let index = 0; index < 4; index++) await runner.runOnce();
    expect(gov.completions.get(broken.attemptId)).toMatchObject({ outcome: "failed", result: "", failure: { reason: "engine", detail: "the model returned nothing", infrastructure: false } });
    // A model that refuses for quota is not the task's doing: the attempt may be retried as it is.
    expect(gov.completions.get(quota.attemptId)).toMatchObject({ outcome: "failed", failure: { reason: "model-refused", infrastructure: true } });
    expect(gov.completions.get(greedy.attemptId)!.failure).toMatchObject({ reason: "limit", infrastructure: false });
    expect(gov.completions.get(greedy.attemptId)!.failure!.detail).toMatch(/used its allowance \(\d+ of 1000 tokens\)/u);
    expect(gov.eventsOf(greedy.attemptId, "tool.call")).toEqual([]);
    expect(gov.completions.get(dear.attemptId)!.failure!.detail).toContain("500 of 100 micro-dollars");
    expect(gov.completions.get(dear.attemptId)!.usage.microUsd).toBe(500);
  });

  it("refuses an attempt whose agent needs an engine this runner does not have", async () => {
    const { gov, runner } = await runnerWorld();
    const offer = gov.offer({ agent: { engines: ["pi", "claude"], native: "all" } });
    await runner.runOnce();
    expect(gov.acks.get(offer.attemptId)).toBe("none");
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "failed", engine: "none", failure: { reason: "runner", infrastructure: true, detail: 'this runner cannot run agent worker: it needs one of pi, claude with native tools "all", and the runner has fixture without an engine sandbox' } });
  });
});

describe("calls with an effect", () => {
  const tools = (gov: Awaited<ReturnType<typeof runnerWorld>>["gov"], stateDir: string) => [gov.tool("deploy.restart", { effect: "privileged", script: markerScript(stateDir, "restarted"), inputSchema: { type: "object", properties: { container: { type: "string" } }, required: ["container"] } })];
  const goal = 'FIXTURE tool deploy.restart {"container": "web"}\nFIXTURE reply The tool answered: %last%';

  it("asks first and runs a call that is approved at once (a standing approval)", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    const offer = gov.offer({ tools: tools(gov, stateDir), task: { goal } });
    await runner.runOnce();
    expect(gov.toolCalls).toEqual([{ fence: 1, callId: `${offer.attemptId}-call-1`, tool: "deploy.restart", input: { container: "web" }, baseCommits: {} }]);
    expect(existsSync(join(stateDir, "restarted"))).toBe(true);
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: 'The tool answered: {"done":true}' });
  });

  it("waits for a person and runs the call once it is approved", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    gov.onToolCall = (request) => { setTimeout(() => gov.approvals.set("approval-1", { state: "approved" }), 30); return { callId: request.callId, state: "pending", approvalId: "approval-1" }; };
    const offer = gov.offer({ tools: tools(gov, stateDir), task: { goal } });
    await runner.runOnce();
    expect(existsSync(join(stateDir, "restarted"))).toBe(true);
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "succeeded", output: { done: true } });
    expect(gov.completions.get(offer.attemptId)!.outcome).toBe("succeeded");
  });

  it("tells the agent the reason when a person rejects, and does not run the call", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    gov.approvals.set("approval-1", { state: "rejected", reason: "not during office hours" });
    gov.onToolCall = (request) => ({ callId: request.callId, state: "pending", approvalId: "approval-1" });
    const offer = gov.offer({ tools: tools(gov, stateDir), task: { goal } });
    await runner.runOnce();
    expect(existsSync(join(stateDir, "restarted"))).toBe(false);
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "rejected", output: { status: "rejected", reason: "not during office hours" } });
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: expect.stringContaining("not during office hours") as string });
  });

  it("tells the agent the call is held when nobody decides in time, lets it finish and ends held", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    gov.onToolCall = (request) => ({ callId: request.callId, state: "pending", approvalId: "approval-1" });
    const offer = gov.offer({ tools: tools(gov, stateDir), task: { goal } });
    await runner.runOnce();
    expect(existsSync(join(stateDir, "restarted"))).toBe(false);
    expect(gov.eventsOf(offer.attemptId, "tool.result")[0]).toMatchObject({ outcome: "held", output: { status: "held", approvalId: "approval-1" } });
    const done = gov.completions.get(offer.attemptId)!;
    expect(done.outcome).toBe("held");
    expect(done.result).toContain("has NOT happened");
    expect(done.failure).toBeUndefined();
  });

  it("uploads the working copy's patch before it asks and names the commit it stands on, so the Governor has both for the call", async () => {
    const { gov, runner } = await runnerWorld();
    const origin = bareRepository({ "a.txt": "a\n" });
    let patchesAtCall = -1;
    gov.onBrainTool = () => { patchesAtCall = gov.artifacts.filter((artifact) => artifact.kind === "patch").length; return { state: "done", output: { url: "https://example.test/pr/1", number: 1, branch: "brain/task-1" } }; };
    const offer = gov.offer({ agent: { native: "all" }, projects: [project(origin.repo)], tools: [gov.tool("git.open-pr", { runs: "brain", effect: "write", inputSchema: { type: "object" } })], task: { goal: 'FIXTURE write app/b.txt b\\n\nFIXTURE tool git.open-pr {"project": "app", "title": "Add b", "body": "b"}\nFIXTURE reply opened %last%' } });
    await runner.runOnce();
    expect(patchesAtCall).toBe(1);
    // The patch did not change after the call, so it was not uploaded a second time.
    expect(gov.artifacts.filter((artifact) => artifact.kind === "patch")).toHaveLength(1);
    expect(gov.completions.get(offer.attemptId)!.workingCopy!.digest).toBe(gov.artifacts[0]!.digest);
    // This is the goal's first attempt: the offer named no commit, so only the runner knows which one it found.
    expect(offer.projects[0]?.baseCommit).toBeUndefined();
    expect(gov.brainCalls).toMatchObject([{ tool: "git.open-pr", baseCommits: { app: origin.head() } }]);
  });

  it("sends a Brain-run call again once its approval is given, and stops calling after a question to a person", async () => {
    const { gov, runner } = await runnerWorld();
    gov.approvals.set("approval-7", { state: "approved" });
    gov.onBrainTool = (request) => (request.tool === "task.ask" ? { state: "done", output: { status: "waiting" } }
      : gov.brainCalls.filter((call) => call.callId === request.callId).length === 1 ? { state: "pending", approvalId: "approval-7" } : { state: "done", output: { sent: true } });
    const brain = (name: string, effect: "read" | "write") => gov.tool(name, { runs: "brain", effect, inputSchema: { type: "object" } });
    const offer = gov.offer({ tools: [brain("message.send", "write"), brain("task.ask", "read"), brain("task.note", "read")], task: { goal: 'FIXTURE tool message.send {"text": "hi"}\nFIXTURE tool task.ask {"question": "Which one?"}\nFIXTURE tool task.note {"text": "after asking"}\nFIXTURE reply I am waiting for the answer. %last%' } });
    await runner.runOnce();
    expect(gov.brainCalls.map((call) => call.tool)).toEqual(["message.send", "message.send", "task.ask"]);
    expect(gov.eventsOf(offer.attemptId, "tool.result").map((event) => [event.outcome, event.output])).toEqual([["succeeded", { sent: true }], ["succeeded", { status: "waiting" }]]);
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", result: expect.stringContaining("waits for a person's answer") as string });
  });
});

describe("plan, check and judge attempts", () => {
  it("returns a planner's plan as output", async () => {
    const { gov, runner } = await runnerWorld();
    const offer = gov.offer({ kind: "plan", agent: { name: "planner" }, task: { title: "Ship the feature", goal: "Make it work." }, context: { catalog: { agents: [{ name: "planner", description: "Plans." }, { name: "worker", description: "Works." }], tools: [], plays: [] } } });
    await runner.runOnce();
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", output: { summary: "fixture plan", tasks: [{ title: "Ship the feature", goal: "Ship the feature", agent: "worker", after: [] }] } });
  });

  it("gives a checker the result, its tool calls and the patch as a file, and returns a verdict that depends on the round", async () => {
    const { gov, runner } = await runnerWorld();
    const diff = "diff --git a/app/a.txt b/app/a.txt\n--- a/app/a.txt\n+++ b/app/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const patch = gov.blob(buildPatch([{ project: "app", diff: new Uint8Array(Buffer.from(diff)) }]));
    const check = (round: number) => gov.offer({
      kind: "check", agent: { name: "reviewer", native: "read" }, prompt: "# Reviewer\nFIXTURE read .brain/attempt-work.patch",
      task: { round, goal: 'Change a to b.\nFIXTURE @work write app/a.txt b\nFIXTURE @check #1 json {"pass": false, "score": 0.3, "findings": "no test"}\nFIXTURE @check #2+ json {"pass": true, "score": 0.9, "findings": "tested"}' },
      context: { review: [{ attemptId: "attempt-work", agent: "developer", result: "Changed a to b.", toolCalls: [], files: [], patch }] },
    });
    const first = check(1);
    const second = check(2);
    await runner.runOnce();
    await runner.runOnce();
    expect(gov.completions.get(first.attemptId)).toMatchObject({ outcome: "succeeded", output: { pass: false, score: 0.3, findings: "no test" } });
    expect(gov.completions.get(second.attemptId)).toMatchObject({ outcome: "succeeded", output: { pass: true, score: 0.9, findings: "tested" } });
    // The checker read the patch file the task text names; the worker's script line in the goal did not run for it.
    expect(gov.eventsOf(first.attemptId, "native.call").map((event) => event.name)).toEqual(["read"]);
    expect(gov.eventsOf(first.attemptId, "native.result")[0]!.output).toBe(diff);
    // A check uploads no working-copy patch: only work changes the task's working copy.
    expect(gov.artifacts).toEqual([]);
  });

  it("shows a checker the files the reviewed attempt kept: as a file to read, or as text when it can read none", async () => {
    const { gov, runner } = await runnerWorld();
    const file = { name: "page.md", ...gov.blob("# The page\nHello") };
    const review = [{ attemptId: "attempt-work", agent: "worker", result: "Wrote it.", toolCalls: [], files: [file] }];
    const reader = gov.offer({ kind: "check", agent: { name: "reviewer", native: "read" }, prompt: "FIXTURE read .brain/attempt-work/files/page.md", task: { goal: 'FIXTURE @check json {"pass": true, "score": 1, "findings": "ok"}' }, context: { review } });
    const blind = gov.offer({ kind: "check", agent: { name: "reviewer", native: "none" }, prompt: 'FIXTURE @check json {"pass": true, "score": 1, "findings": "ok"}', context: { review } });
    await runner.runOnce();
    await runner.runOnce();
    expect(gov.eventsOf(reader.attemptId, "native.result")[0]!.output).toBe("# The page\nHello");
    expect(gov.completions.get(blind.attemptId)).toMatchObject({ outcome: "succeeded" });
  });

  it("asks once for a correction when the answer is not the required JSON, and fails clearly when it still is not", async () => {
    const { gov, runner } = await runnerWorld();
    const corrected = gov.offer({ kind: "check", prompt: 'FIXTURE @check reply It looks fine to me.\nFIXTURE @correction json {"pass": true, "score": 0.8, "findings": "fine"}' });
    const stubborn = gov.offer({ kind: "check", prompt: 'FIXTURE @check json {"pass": "yes"}' });
    await runner.runOnce();
    await runner.runOnce();
    const fixed = gov.completions.get(corrected.attemptId)!;
    expect(fixed).toMatchObject({ outcome: "succeeded", result: '{"pass":true,"score":0.8,"findings":"fine"}', output: { pass: true, score: 0.8, findings: "fine" } });
    // Both sessions are counted in the attempt's usage.
    expect(fixed.usage.outputTokens).toBeGreaterThan(Math.ceil("It looks fine to me.".length / 4));
    expect(gov.completions.get(stubborn.attemptId)).toMatchObject({
      outcome: "failed", result: '{"pass":"yes"}',
      failure: { reason: "engine", infrastructure: true, detail: 'the agent\'s final answer is not the required JSON ({"pass": true, "score": 0.9, "findings": "string"}): the reply is not a JSON object' },
    });
  });

  it("has a judge keep exactly one of the candidates", async () => {
    const { gov, runner } = await runnerWorld();
    const review = ["attempt-a", "attempt-b"].map((attemptId) => ({ attemptId, agent: "developer", result: `Result of ${attemptId}.`, toolCalls: [], files: [] }));
    const picks = gov.offer({ kind: "judge", agent: { name: "judge" }, prompt: 'FIXTURE json {"keep": "attempt-b", "findings": "b is complete"}', context: { review } });
    const invents = gov.offer({ kind: "judge", agent: { name: "judge" }, prompt: 'FIXTURE json {"keep": "attempt-z", "findings": "z"}', context: { review } });
    await runner.runOnce();
    await runner.runOnce();
    expect(gov.completions.get(picks.attemptId)).toMatchObject({ outcome: "succeeded", output: { keep: "attempt-b", findings: "b is complete" } });
    expect(gov.completions.get(invents.attemptId)!.failure!.detail).toContain('"keep" must be the attempt id of one candidate: attempt-a, attempt-b');
  });
});

describe("an act attempt", () => {
  const act = (gov: Awaited<ReturnType<typeof runnerWorld>>["gov"], stateDir: string) => gov.offer({
    kind: "act", tools: [gov.tool("deploy.restart", { effect: "privileged", script: markerScript(stateDir, "restarted"), inputSchema: { type: "object", properties: { container: { type: "string" } }, required: ["container"] } })],
    act: { callId: "attempt-0-call-1", approvalId: "approval-1", tool: "deploy.restart", input: { container: "web" } },
  });

  it("runs exactly the approved call, with no engine, and reports its outcome", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    gov.approvals.set("approval-1", { state: "approved" });
    const offer = act(gov, stateDir);
    await runner.runOnce();
    expect(existsSync(join(stateDir, "restarted"))).toBe(true);
    expect(gov.toolCalls).toEqual([]);
    expect(gov.acks.get(offer.attemptId)).toBe("none");
    expect(gov.eventsOf(offer.attemptId).filter((event) => event.kind.startsWith("tool.")).map((event) => [event.kind, (event as { callId: string }).callId])).toEqual([["tool.call", "attempt-0-call-1"], ["tool.result", "attempt-0-call-1"]]);
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", engine: "none", result: '{"done":true}', output: { tool: "deploy.restart", outcome: "succeeded", output: { done: true } }, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 } });
  });

  it("runs nothing when the approval is no longer current", async () => {
    const { gov, runner, stateDir } = await runnerWorld();
    gov.approvals.set("approval-1", { state: "expired" });
    const offer = act(gov, stateDir);
    await runner.runOnce();
    expect(existsSync(join(stateDir, "restarted"))).toBe(false);
    expect(gov.completions.get(offer.attemptId)).toMatchObject({ outcome: "succeeded", output: { tool: "deploy.restart", outcome: "failed", output: { error: "The approval of this call is expired, so nothing was run." } } });
  });
});
