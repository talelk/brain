import { readFileSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";

/** Where the task starts when a Governor context pack precedes it in the prompt. */
const TASK_MARK = "\n\n# Task\n";

/**
 * Test hook for concurrency and long-attempt tests: when set, every fixture session waits for `hold` (keyed by its attempt) before it
 * answers, so a test decides how long each attempt runs. Unset in production, where the fixture answers at once.
 */
export const fixtureGate: { hold?: (attemptId: string, signal: AbortSignal) => Promise<void> } = {};

const isCoordinator = (instructions: string): boolean => instructions.includes("# Plan Coordinator");

/**
 * The fixture's coordinator, a stand-in for a model reading the Governor's coordinator pack (ADR 0048). A message to the mission may script
 * its calls as `FIXTURE_CALL_TOOL {...}` lines, exactly as a task's situation does for a worker. Without a script it plans like a careful
 * coordinator would, from the pack alone: it adds a source check after the last task, then a follow-up for the first task that was verified,
 * and it proposes nothing while a proposal of its own still waits for a person.
 */
function coordinatorCalls(task: string): Array<{ id: string; input: Record<string, unknown> }> {
  const at = task.indexOf(TASK_MARK);
  const pack = at >= 0 ? task.slice(0, at) : "";
  const scripted = [...pack.matchAll(/FIXTURE_CALL_TOOL (\{.*\})/gu)].map((match) => JSON.parse(match[1]!) as { id: string; input: Record<string, unknown> });
  if (scripted.length > 0) return scripted;
  if (pack.includes("## Plan proposals waiting for a person")) return [];
  const line = /^Tasks: (\[.*\])$/mu.exec(pack);
  if (!line) return [];
  const tasks = JSON.parse(line[1]!) as Array<{ id: string; title: string; dependsOn: string[]; criterionIds?: string[]; assignment?: unknown }>;
  const reasons = ((): string[] => { try { return (JSON.parse(task.slice(at + TASK_MARK.length)) as { reasons?: string[] }).reasons ?? []; } catch { return []; } })();
  const worker = /^- ([a-z][a-z0-9.-]*): .*\(agent (?!plan-coordinator)[a-z0-9.-]+,/mu.exec(pack)?.[1];
  const criteria = [...pack.matchAll(/^(c[1-9][0-9]*): /gmu)].map((match) => match[1]!);
  if (!worker) return [];
  const assignment = { kind: "agent", id: worker, role: "specialist" };
  const propose = (summary: string, added: unknown) => [{ id: "mission.propose-plan", input: { summary, tasks: [...tasks, added] } }];
  if (!tasks.some((entry) => entry.id === "check-sources")) {
    const leaves = tasks.filter((entry) => !tasks.some((other) => other.dependsOn.includes(entry.id))).map((entry) => entry.id);
    return propose("Check every claim against its source before the mission is signed off", { id: "check-sources", title: "Check each claim in the brief against its source", criteria: ["Every claim has a source or is marked as an assumption"], dependsOn: leaves, ...(criteria.includes("c2") ? { criterionIds: ["c2"] } : {}), assignment });
  }
  const verified = tasks.find((entry) => reasons.some((reason) => reason.startsWith("work-verified") && reason.endsWith(entry.title)));
  if (verified && !tasks.some((entry) => entry.id === "follow-up")) {
    return propose(`Follow up on what ${verified.id} found`, { id: "follow-up", title: "Resolve the open questions the finished work left", criteria: ["Each open question is answered or marked unresolved"], dependsOn: [verified.id], ...(criteria.includes("c3") ? { criterionIds: ["c3"] } : {}), assignment });
  }
  return [];
}

export class FixtureEngine implements EngineAdapter {
  readonly id = "fixture";
  private seq = 0;
  private sessionId = "";
  private attemptId = "";
  private stream = new EngineEventStream();
  private pendingTool: ((result: EngineToolExecutionResult) => void) | undefined;

  constructor(private readonly toolBindings: readonly EngineToolBinding[] = []) {}

  async probe() {
    return { id: "fixture", adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: ["sessions", "steer"] };
  }

  private push(kind: EngineEvent["kind"], payload: EngineEvent["payload"]): void {
    this.seq += 1;
    this.stream.push({
      contractVersion: "brain.engine-event/v1", eventId: `fixture-evt-${this.seq}`,
      sessionId: this.sessionId, attemptId: this.attemptId, sequence: this.seq,
      occurredAt: new Date().toISOString(), kind, payload,
    } as EngineEvent);
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal) {
    this.seq = 0;
    this.stream = new EngineEventStream();
    this.sessionId = `fixture-${spec.attemptId}`;
    this.attemptId = spec.attemptId;
    this.push( "session.started", { engine: await this.probe() });
    void Promise.resolve().then(async () => {
      let response: unknown = { text: "fixture complete" };
      let indented = false;
      try {
        const input = JSON.parse(spec.task.includes(TASK_MARK) ? spec.task.slice(spec.task.indexOf(TASK_MARK) + TASK_MARK.length) : spec.task) as Record<string, unknown>;
        if (typeof input["message"] === "string" && typeof input["tasks"] === "string") {
          const tasks = JSON.parse(input["tasks"]) as { id: string }[];
          const support = /support|reply|ticket|sign in/iu.test(input["message"]);
          const selected = tasks.find((task) => task.id === (support ? "support-draft" : "operations-triage"));
          response = { reply: "Fixture proposal: review the task inputs before starting.", workflowId: selected?.id ?? null, input: selected ? support ? { title: "Support request", body: input["message"] } : { situation: input["message"] } : {}, questions: [] };
        }
        if (typeof input["intent"] === "string" && Array.isArray(input["successCriteria"])) {
          // The planner reads each criterion as "c1: words" and names the ids a task serves (ADR 0034): the fixture's last two steps serve them all.
          const served = (input["successCriteria"] as unknown[]).map((entry) => /^(c[1-9][0-9]*): /u.exec(String(entry))?.[1]).filter((id): id is string => id !== undefined);
          const serves = served.length > 0 ? { criterionIds: served } : {};
          response = {
            summary: "Fixture strategy: inspect first, then make and verify a bounded change.",
            tasks: [
              { id: "investigate", title: `Investigate: ${String(input["title"])}`, criteria: ["investigation-complete"], dependsOn: [], assignment: { kind: "agent", id: "fixture", role: "specialist" } },
              { id: "implement", title: "Implement the reviewed change", criteria: ["change-verified"], dependsOn: ["investigate"], workflowId: "operations-triage", ...serves },
              { id: "review", title: "Independently review the outcome", criteria: ["outcome-accepted"], dependsOn: ["implement"], assignment: { kind: "agent", id: "fixture", role: "reviewer" }, ...serves },
            ],
          };
        }
        if (typeof input["situation"] === "string" && (spec.instructions.includes("General Task Worker") || spec.instructions.includes("SRE Operator"))) {
          // The general task worker: a written deliverable that answers every acceptance criterion of the brief.
          const lines = input["situation"].split("\n");
          const criteria = lines.slice(lines.indexOf("Acceptance criteria:") + 1).map((line) => /^\d+\. (.+)$/u.exec(line)?.[1]).filter((line): line is string => line !== undefined && lines.includes("Acceptance criteria:"));
          const title = lines[0] ?? "Task";
          // A model writes its JSON indented, so the raw text artifact and the normalised output artifact have different digests, as they do live.
          indented = true;
          response = {
            summary: `Fixture result for: ${title}`,
            deliverable: `# ${title}\n\n## Findings\n\nThe fixture worker reasoned about this task and wrote a short report so that the whole path from the brief to a verified deliverable can be exercised end to end without a model.\n\n| Option | Cost | Effort |\n| :--- | ---: | :---: |\n| Keep as is | **Low** | Small |\n| Rework | Medium | Large |\n\n- First point, with \`inline code\`\n- Second point\n  - A nested detail\n\n## Assumptions\n\nNo facts beyond the brief were available, so the fixture assumes the brief is complete and says so here.`,
            criteria: criteria.map((criterion) => ({ criterion, met: true, evidence: "The Findings section of the deliverable addresses this criterion." })),
            assumptions: ["The brief is complete"],
          };
        } else if (typeof input["situation"] === "string") response = { summary: `Fixture: ${input["situation"]}`, blockers: [], nextActions: ["Inspect diagnostic inputs"] };
        if (isCoordinator(spec.instructions) && typeof input["missionId"] === "string") response = { summary: "Fixture coordinator: nothing to change." };
        if (typeof input["title"] === "string" && typeof input["body"] === "string") response = { summary: `Fixture: ${input["title"]}`, missingInformation: [], risk: "low", proposedReply: `Fixture draft: ${input["body"]}` };
      } catch { /* Plain-text engine conformance tasks use the default response. */ }
      // Test hook for the governed tool broker: a situation holding `FIXTURE_CALL_TOOL {"id":"documents.read","input":{...}}` makes the fixture
      // propose that tool exactly as a model would, wait for the broker's result and quote it in its deliverable.
      // A situation may hold several such lines: the fixture proposes them one after the other, each waiting for its own answer.
      let calls = 0;
      for (const requested of this.requestedTools(spec.task, spec.instructions)) {
        const binding = this.toolBindings.find((candidate) => candidate.release.id === requested.id);
        if (!binding) continue;
        calls += 1;
        const proposalId = `fixture-call-${spec.attemptId}${calls > 1 ? `-${calls}` : ""}`;
        const waited = new Promise<EngineToolExecutionResult>((resolve) => { this.pendingTool = resolve; });
        this.push("tool.proposed", { proposalId, tool: binding.release, input: requested.input, target: binding.target, inputDigest: sha256Digest(new TextEncoder().encode(JSON.stringify(requested.input))) } as never);
        const answered = await waited;
        this.push("tool.result", { proposalId, invocationId: answered.invocationId, receipt: answered.receipt });
        if (isCoordinator(spec.instructions) && response && typeof (response as { summary?: unknown }).summary === "string") {
          const report = response as { summary: string };
          report.summary = `Fixture coordinator: called ${requested.id}; ${JSON.stringify(answered.output).slice(0, 600)}`;
        }
        if (response && typeof response === "object" && typeof (response as { deliverable?: unknown }).deliverable === "string") {
          const report = response as { summary: string; deliverable: string };
          if (calls === 1) report.summary = `${report.summary} (used ${requested.id})`;
          report.deliverable = `${report.deliverable}\n\nTool output (${requested.id}): ${JSON.stringify(answered.output).slice(0, 1500)}`;
        }
      }
      await fixtureGate.hold?.(spec.attemptId, signal);
      const text = spec.task.includes("BRAIN_OK") ? "BRAIN_OK" : JSON.stringify(response, null, indented ? 2 : 0);
      const bytes = new TextEncoder().encode(text);
      const artifact = {
        artifactId: `fixture-output-${spec.attemptId}`, digest: sha256Digest(bytes), bytes: bytes.length,
        mediaType: "text/plain", classification: "internal" as const,
      };
      this.push( "text", { text, channel: "assistant", provisional: true });
      this.push( "artifact", { artifact, purpose: "output" });
      this.push( "session.stopped", { reason: "completed", terminationConfirmed: true, output: artifact });
      this.stream.close();
    });
    if (signal.aborted) await this.cancel(this.sessionId, "aborted before start");
    return { sessionId: this.sessionId };
  }

  private requestedTools(task: string, instructions: string): Array<{ id: string; input: Record<string, unknown> }> {
    if (isCoordinator(instructions)) return coordinatorCalls(task);
    try {
      // A resumed task carries a plain-words note of what became of its earlier proposals after the JSON brief (ADR 0028): the brief is what is parsed.
      const brief = task.split("\n\n# Changes you proposed earlier")[0]!;
      const body = JSON.parse(brief.includes(TASK_MARK) ? brief.slice(brief.indexOf(TASK_MARK) + TASK_MARK.length) : brief) as { situation?: unknown };
      if (typeof body.situation !== "string") return [];
      return [...body.situation.matchAll(/FIXTURE_CALL_TOOL (\{.*\})/gu)].map((match) => JSON.parse(match[1]!) as { id: string; input: Record<string, unknown> });
    } catch { return []; }
  }

  async toolResult(_sessionId: string, result: EngineToolExecutionResult): Promise<void> {
    if (!this.pendingTool) throw new Error("tool result does not match a pending proposal");
    const resolve = this.pendingTool;
    this.pendingTool = undefined;
    resolve(result);
  }

  async *events(_sessionId: string, after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    yield* this.stream.after(after, signal);
  }

  async cancel(_sessionId?: string, _reason?: string) {
    this.stream.close();
    return { terminationConfirmed: true };
  }

  /**
   * Fixture steering: a trivial append to the engine transcript. The message
   * lands as a diagnostic text record so it never pollutes captured output;
   * steering an unknown session is refused.
   */
  async steer(sessionId: string, messageId: string, message: string): Promise<void> {
    if (this.sessionId !== sessionId) {
      throw Object.assign(new Error(`Fixture steering requires the live session, not ${sessionId}`), { code: "UNSUPPORTED_CAPABILITY" });
    }
    this.push("text", { text: `[steer:${messageId}] ${message}`, channel: "diagnostic", provisional: true });
  }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("Fixture checkpointing is unsupported"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async dispose(_sessionId?: string) { this.stream.close(); }
}
