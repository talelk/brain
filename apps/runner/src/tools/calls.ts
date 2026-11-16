import type { ApprovalState, AttemptEventBody, BrainToolResponse, JobOffer, JsonValue, OfferTool, ToolOutcome } from "@brain/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import { isJsonObject } from "../engines/json-reply";
import { boundedToolText } from "../engines/tool-calls";
import { type GovernorClient, isLeaseLost } from "../governor-client";
import type { Launcher } from "../launcher-client";
import { type ApprovalVerdict, type ApprovalWait, waitForApproval } from "./approval";
import { runScriptTool, type ToolRunResult } from "./script";

/**
 * The workspace-tool and Brain-run-tool calls of one attempt (docs/architecture.md section 7). Every call is validated against the
 * tool's input schema, recorded as a `tool.call` and a `tool.result` event, and carried out by what the tool is:
 * - a script (`run.sh`) runs in a tool sandbox; a host command runs through the launcher's operator-declared commands;
 * - a Brain-run tool is carried out by the Governor.
 * A `read` call runs at once. A `write` or `privileged` call is first asked for: approved, it runs; pending, the runner waits for a
 * person (ten minutes), then runs it, or tells the agent why not, or tells it the call is held and lets the session finish.
 */
export interface CallResult { readonly outcome: ToolOutcome; readonly output: JsonValue }

export interface ToolCallsDeps {
  readonly offer: JobOffer;
  readonly client: Pick<GovernorClient, "toolCall" | "approval" | "brainTool" | "secret" | "blob">;
  readonly launcher: Launcher | undefined;
  readonly attemptDir: string;
  readonly emit: (event: AttemptEventBody) => void;
  /** Uploads the working copy's current patch when it changed, before a call with an effect is asked for: the Governor may need it (a pull request is opened from it). */
  readonly syncPatch: () => Promise<void>;
  /** The lease is gone: the attempt must stop. */
  readonly leaseLost: () => void;
  readonly approval?: ApprovalWait;
  /** TEST ONLY: see `ScriptRun.unsandboxedForTests`. */
  readonly unsandboxedForTests: boolean;
  readonly signal: AbortSignal;
}

const failed = (error: string): CallResult => ({ outcome: "failed", output: { error } });
const ran = (result: ToolRunResult): CallResult => ({ outcome: result.ok ? "succeeded" : "failed", output: result.output });
const NOT_DONE = "The call was not made. Do not repeat it and do not look for another way to do the same thing.";

export class ToolCalls {
  /** Calls this attempt asked for that still wait for a person: the attempt ends `held`. */
  held = 0;
  /** A question to a person was recorded (`task.ask`): the session should end its turn. */
  waitingForPerson = false;
  private sequence = 0;
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly problemsOf = new Map<string, (input: JsonValue) => string | undefined>();

  constructor(private readonly deps: ToolCallsDeps) {}

  /** What is wrong with a call's input, by the tool's input schema; nothing when it fits. */
  inputProblem(tool: OfferTool, input: JsonValue): string | undefined {
    let check = this.problemsOf.get(tool.name);
    if (!check) {
      try {
        const validate = this.ajv.compile(tool.inputSchema);
        check = (value) => (validate(value) ? undefined : this.ajv.errorsText(validate.errors, { dataVar: "input" }));
      } catch (error) {
        const reason = `the input schema of tool ${tool.name} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`;
        check = () => reason;
      }
      this.problemsOf.set(tool.name, check);
    }
    return check(input);
  }

  /** One call the model made. Returns the text the model is shown. */
  async call(toolName: string, input: JsonValue): Promise<string> {
    const { offer, emit } = this.deps;
    const tool = offer.agent.tools.includes(toolName) ? offer.tools.find((candidate) => candidate.name === toolName) : undefined;
    if (!tool) return JSON.stringify({ refused: true, error: `There is no tool ${toolName} in this task.` });
    if (this.waitingForPerson) return JSON.stringify({ refused: true, error: "This task now waits for a person's answer. Make no more calls: end your turn and say what you are waiting for." });
    const callId = `${offer.attemptId}-call-${++this.sequence}`;
    emit({ kind: "tool.call", callId, tool: tool.name, effect: tool.effect, input });
    let result: CallResult;
    try {
      const problem = this.inputProblem(tool, input);
      result = problem ? failed(`The input does not fit the tool's inputs: ${problem}`) : tool.runs === "brain" ? await this.brain(tool, callId, input) : tool.effect === "read" ? ran(await this.perform(tool, callId, input)) : await this.withApproval(tool, callId, input);
    } catch (error) {
      if (isLeaseLost(error)) this.deps.leaseLost();
      result = failed(`The call could not be carried out: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`);
    }
    emit({ kind: "tool.result", callId, outcome: result.outcome, output: result.output });
    return boundedToolText(result.output);
  }

  /** The one approved call of an `act` attempt: run exactly as it was approved, with the call id it was asked under. */
  async act(act: NonNullable<JobOffer["act"]>): Promise<CallResult> {
    const { offer, emit, client } = this.deps;
    const tool = offer.tools.find((candidate) => candidate.name === act.tool);
    emit({ kind: "tool.call", callId: act.callId, tool: act.tool, effect: tool?.effect ?? "privileged", input: act.input });
    let result: CallResult;
    try {
      const problem = tool ? this.inputProblem(tool, act.input) : `the offer does not carry tool ${act.tool}`;
      // The approval is read once more at the last moment: a change is never made on an approval that is no longer current.
      const state: ApprovalState | undefined = problem ? undefined : (await client.approval(offer.attemptId, act.approvalId, { fence: offer.fence })).state;
      if (problem || !tool) result = failed(`The approved call cannot be run: ${problem}`);
      else if (state !== "approved") result = failed(`The approval of this call is ${state}, so nothing was run.`);
      else if (tool.runs === "brain") result = this.brainAnswer(await client.brainTool(offer.attemptId, { fence: offer.fence, callId: act.callId, tool: tool.name, input: act.input }));
      else result = ran(await this.perform(tool, act.callId, act.input));
    } catch (error) {
      if (isLeaseLost(error)) this.deps.leaseLost();
      result = failed(`The approved call could not be carried out: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`);
    }
    emit({ kind: "tool.result", callId: act.callId, outcome: result.outcome, output: result.output });
    return result;
  }

  /** Runs a script tool or a host command now. */
  private async perform(tool: OfferTool, callId: string, input: JsonValue): Promise<ToolRunResult> {
    const { offer, client, launcher } = this.deps;
    if (tool.hostCommand !== undefined) {
      if (!launcher) return { ok: false, output: { error: "Host commands need the launcher on this runner, and it has none. The command was not run." } };
      // The tool's inputs are the command's named arguments; the launcher checks each against the operator's pattern.
      const args = Object.fromEntries(Object.entries(isJsonObject(input) ? input : {}).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]));
      try {
        const done = await launcher.hostCommand(tool.hostCommand, args, tool.effect === "read" ? "read" : "privileged", callId);
        if (done.timedOut) return { ok: false, output: { error: "the command ran longer than its timeout and was stopped", output: done.stdout } };
        return done.exitCode === 0 ? { ok: true, output: done.stdout.trim() } : { ok: false, output: { error: `the command ended with exit code ${done.exitCode}`, output: done.stdout, stderr: done.stderr } };
      } catch (error) {
        return { ok: false, output: { error: error instanceof Error ? error.message.slice(0, 500) : "the launcher refused the command" } };
      }
    }
    return runScriptTool({
      attemptId: offer.attemptId, attemptDir: this.deps.attemptDir, tool, callId, input, launcher, unsandboxedForTests: this.deps.unsandboxedForTests, signal: this.deps.signal,
      blob: (ref) => client.blob(ref),
      secret: async (name) => (await client.secret(offer.attemptId, { fence: offer.fence, name, use: { tool: tool.name } })).value,
    });
  }

  private wait(approvalId: string): Promise<ApprovalVerdict> {
    const { offer, client } = this.deps;
    return waitForApproval(() => client.approval(offer.attemptId, approvalId, { fence: offer.fence }), { ...this.deps.approval, signal: this.deps.signal }, isLeaseLost);
  }

  private notApproved(verdict: Exclude<ApprovalVerdict, { state: "approved" }>, approvalId: string | undefined): CallResult {
    if (verdict.state === "rejected") return { outcome: "rejected", output: { status: "rejected", reason: verdict.reason, note: NOT_DONE } };
    this.held += 1;
    return { outcome: "held", output: { status: "held", ...(approvalId ? { approvalId } : {}), note: "This call waits for a person's approval and has NOT happened; if it is approved, Brain runs it after you finish. Do not repeat it and do not look for another way. Finish your work now and say in your answer that this call is held." } };
  }

  /** A script or host-command call with an effect: asked for, then run only once it is approved. */
  private async withApproval(tool: OfferTool, callId: string, input: JsonValue): Promise<CallResult> {
    const { offer, client } = this.deps;
    await this.deps.syncPatch();
    const asked = await client.toolCall(offer.attemptId, { fence: offer.fence, callId, tool: tool.name, input });
    const verdict: ApprovalVerdict = asked.state === "approved" ? { state: "approved" }
      : asked.state === "pending" && asked.approvalId ? await this.wait(asked.approvalId)
      : { state: "rejected", reason: asked.reason ?? (asked.state === "expired" ? "the approval expired without a decision" : "the call was rejected") };
    return verdict.state === "approved" ? ran(await this.perform(tool, callId, input)) : this.notApproved(verdict, asked.approvalId);
  }

  private brainAnswer(answer: BrainToolResponse): CallResult {
    if (answer.state === "done") {
      // A question to a person answers at once with a waiting status: the session should end, the answer comes with the next attempt.
      if (isJsonObject(answer.output) && answer.output["status"] === "waiting") this.waitingForPerson = true;
      return { outcome: "succeeded", output: answer.output };
    }
    if (answer.state === "failed") return failed(answer.error);
    if (answer.state === "rejected") return { outcome: "rejected", output: { status: "rejected", reason: answer.reason, note: NOT_DONE } };
    return this.notApproved({ state: "held" }, answer.approvalId);
  }

  /** A Brain-run tool: the Governor carries it out. One with an effect may answer pending first; once approved, the same call is sent again and runs. */
  private async brain(tool: OfferTool, callId: string, input: JsonValue): Promise<CallResult> {
    const { offer, client } = this.deps;
    if (tool.effect !== "read") await this.deps.syncPatch();
    const request = { fence: offer.fence, callId, tool: tool.name, input };
    const first = await client.brainTool(offer.attemptId, request);
    if (first.state !== "pending") return this.brainAnswer(first);
    const verdict = await this.wait(first.approvalId);
    return verdict.state === "approved" ? this.brainAnswer(await client.brainTool(offer.attemptId, request)) : this.notApproved(verdict, first.approvalId);
  }
}
