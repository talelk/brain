import { readFileSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";

/** Where the task starts when a Governor context pack precedes it in the prompt. */
const TASK_MARK = "\n\n# Task\n";

export class FixtureEngine implements EngineAdapter {
  readonly id = "fixture";
  private seq = 0;
  private sessionId = "";
  private attemptId = "";
  private stream = new EngineEventStream();
  private pendingTool: ((result: EngineToolExecutionResult) => void) | undefined;

  constructor(private readonly toolBindings: readonly EngineToolBinding[] = []) {}

  async probe() {
    return { id: "fixture", version: "1", adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: ["sessions", "steer"] };
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
      try {
        const input = JSON.parse(spec.task.includes(TASK_MARK) ? spec.task.slice(spec.task.indexOf(TASK_MARK) + TASK_MARK.length) : spec.task) as Record<string, unknown>;
        if (typeof input["message"] === "string" && typeof input["tasks"] === "string") {
          const tasks = JSON.parse(input["tasks"]) as { id: string }[];
          const support = /support|reply|ticket|sign in/iu.test(input["message"]);
          const selected = tasks.find((task) => task.id === (support ? "support-draft" : "operations-triage"));
          response = { reply: "Fixture proposal: review the task inputs before starting.", workflowId: selected?.id ?? null, input: selected ? support ? { title: "Support request", body: input["message"] } : { situation: input["message"] } : {}, questions: [] };
        }
        if (typeof input["intent"] === "string" && Array.isArray(input["successCriteria"])) {
          response = {
            summary: "Fixture strategy: inspect first, then make and verify a bounded change.",
            tasks: [
              { id: "investigate", title: `Investigate: ${String(input["title"])}`, criteria: ["investigation-complete"], dependsOn: [], assignment: { kind: "agent", id: "fixture", role: "specialist" } },
              { id: "implement", title: "Implement the reviewed change", criteria: ["change-verified"], dependsOn: ["investigate"], workflowId: "operations-triage" },
              { id: "review", title: "Independently review the outcome", criteria: ["outcome-accepted"], dependsOn: ["implement"], assignment: { kind: "agent", id: "fixture", role: "reviewer" } },
            ],
          };
        }
        if (typeof input["situation"] === "string" && spec.instructions.includes("General Task Worker")) {
          // The general task worker: a written deliverable that answers every acceptance criterion of the brief.
          const lines = input["situation"].split("\n");
          const criteria = lines.slice(lines.indexOf("Acceptance criteria:") + 1).map((line) => /^\d+\. (.+)$/u.exec(line)?.[1]).filter((line): line is string => line !== undefined && lines.includes("Acceptance criteria:"));
          const title = lines[0] ?? "Task";
          response = {
            summary: `Fixture result for: ${title}`,
            deliverable: `# ${title}\n\n## Findings\n\nThe fixture worker reasoned about this task and wrote a short report so that the whole path from the brief to a verified deliverable can be exercised end to end without a model.\n\n| Option | Cost | Effort |\n| :--- | ---: | :---: |\n| Keep as is | **Low** | Small |\n| Rework | Medium | Large |\n\n- First point, with \`inline code\`\n- Second point\n  - A nested detail\n\n## Assumptions\n\nNo facts beyond the brief were available, so the fixture assumes the brief is complete and says so here.`,
            criteria: criteria.map((criterion) => ({ criterion, met: true, evidence: "The Findings section of the deliverable addresses this criterion." })),
            assumptions: ["The brief is complete"],
          };
        } else if (typeof input["situation"] === "string") response = { summary: `Fixture: ${input["situation"]}`, blockers: [], nextActions: ["Inspect diagnostic inputs"] };
        if (typeof input["title"] === "string" && typeof input["body"] === "string") response = { summary: `Fixture: ${input["title"]}`, missingInformation: [], risk: "low", proposedReply: `Fixture draft: ${input["body"]}` };
      } catch { /* Plain-text engine conformance tasks use the default response. */ }
      // Test hook for the governed tool broker: a situation holding `FIXTURE_CALL_TOOL {"id":"documents.read","input":{...}}` makes the fixture
      // propose that tool exactly as a model would, wait for the broker's result and quote it in its deliverable.
      const requested = this.requestedTool(spec.task);
      if (requested) {
        const binding = this.toolBindings.find((candidate) => candidate.release.id === requested.id);
        if (binding) {
          const proposalId = `fixture-call-${spec.attemptId}`;
          const waited = new Promise<EngineToolExecutionResult>((resolve) => { this.pendingTool = resolve; });
          this.push("tool.proposed", { proposalId, tool: binding.release, input: requested.input, target: binding.target, inputDigest: sha256Digest(new TextEncoder().encode(JSON.stringify(requested.input))) } as never);
          const answered = await waited;
          this.push("tool.result", { proposalId, invocationId: answered.invocationId, receipt: answered.receipt });
          if (response && typeof response === "object" && typeof (response as { deliverable?: unknown }).deliverable === "string") {
            const report = response as { summary: string; deliverable: string };
            report.summary = `${report.summary} (used ${requested.id})`;
            report.deliverable = `${report.deliverable}\n\nTool output (${requested.id}): ${JSON.stringify(answered.output).slice(0, 1500)}`;
          }
        }
      }
      const text = spec.task.includes("BRAIN_OK") ? "BRAIN_OK" : JSON.stringify(response);
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

  private requestedTool(task: string): { id: string; input: Record<string, unknown> } | undefined {
    try {
      const body = JSON.parse(task.includes(TASK_MARK) ? task.slice(task.indexOf(TASK_MARK) + TASK_MARK.length) : task) as { situation?: unknown };
      const match = typeof body.situation === "string" ? /FIXTURE_CALL_TOOL (\{.*\})/u.exec(body.situation) : null;
      return match ? JSON.parse(match[1]!) as { id: string; input: Record<string, unknown> } : undefined;
    } catch { return undefined; }
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
