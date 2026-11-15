import { createHash } from "node:crypto";
import { BRAIN_TOOL_COMMANDS, type JsonValue } from "@brain/contracts";
import type { GovernorClient, SessionGrant } from "../governor-client";
import type { BrokerResult } from "./brokers";

/**
 * Governed Brain tools (ADR 0042): an agent reaches Brain through five operator-declared, release-pinned tools, each of which is exactly one
 * Brain command run as the attempt's own machine principal (ADR 0032). The tool names no command type and no id it cannot know: the mission,
 * the member and the task this attempt serves come from the Governor with the credential. What the call may do is decided by the Governor's
 * authorization matrix and the principal's own-mission scope, never here; a refusal comes back as a failed tool call with its plain reason.
 * The credential stays in this module: it is not part of any tool input, brokered data, event or artifact. The tool-to-command table is
 * shared with the Governor (`BRAIN_TOOL_COMMANDS`), whose session allowlist is exactly its commands.
 */
export const BRAIN_BROKERED: ReadonlySet<string> = new Set(Object.keys(BRAIN_TOOL_COMMANDS));

type Client = Pick<GovernorClient, "sessionCredential" | "actAs">;

/** How soon before its expiry a credential is asked for again. */
const RENEW_BEFORE_MS = 60_000;

/** The attempt's session: asks the Governor for the credential on the first Brain call, keeps it for the attempt, asks again once it is about to expire. */
export class BrainSession {
  private grant: Promise<SessionGrant> | undefined;

  constructor(private readonly client: Client, private readonly attemptId: string, private readonly nowMs: () => number = Date.now) {}

  private credential(): Promise<SessionGrant> {
    if (this.grant) {
      const held = this.grant;
      return held.then((grant) => (Date.parse(grant.expiresAt) - this.nowMs() > RENEW_BEFORE_MS ? grant : this.renew()), () => this.renew());
    }
    return this.renew();
  }

  private renew(): Promise<SessionGrant> {
    this.grant = this.client.sessionCredential(this.attemptId);
    return this.grant;
  }

  /** Runs one Brain tool call. `proposalId` makes a repeat of the same call (a retry after a crash) the same command, never a second one. */
  async call(toolId: string, input: Readonly<Record<string, unknown>>, proposalId: string): Promise<BrokerResult> {
    const commandType = (BRAIN_TOOL_COMMANDS as Record<string, string>)[toolId];
    if (!commandType) return { ok: false, error: `${toolId} is not a Brain tool` };
    let grant: SessionGrant;
    try { grant = await this.credential(); } catch (error) { return { ok: false, error: sessionRefusal(error) }; }
    const built = payloadOf(toolId, input, grant);
    if (typeof built === "string") return { ok: false, error: built };
    const key = `brain-${createHash("sha256").update(`${this.attemptId}\n${proposalId}`).digest("hex").slice(0, 40)}`;
    try {
      const sent = await this.client.actAs(grant.credential, "/v1/commands", { contractVersion: "brain.command/v1", commandId: key, commandType, workspaceId: grant.workspaceId, idempotencyKey: key, payload: built });
      if (sent.status !== 200) return { ok: false, error: refusalOf(sent.json, sent.status) };
      const receipt = sent.json as { accepted?: boolean; resourceId?: string };
      if (receipt.accepted === false) return { ok: false, error: refusalOf(sent.json, sent.status) };
      return { ok: true, data: await describe(toolId, receipt.resourceId, grant, this.client) };
    } catch (error) { return { ok: false, error: `Brain could not be reached: ${error instanceof Error ? error.message.slice(0, 160) : "the call failed"}. Carry on without this call and say so in your answer.` }; }
  }
}

/** The command payload of one tool call, or the plain reason it cannot be made. Ids come from the grant, never from the model. */
function payloadOf(toolId: string, input: Readonly<Record<string, unknown>>, grant: SessionGrant): Record<string, JsonValue> | string {
  const text = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  const defined = <T extends Record<string, JsonValue | undefined>>(entries: T): Record<string, JsonValue> => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
  switch (toolId) {
    case "mission.propose-plan":
      return defined({ missionId: grant.missionId, origin: "agent", summary: text("summary"), tasks: input["tasks"] as JsonValue, team: input["team"] as JsonValue | undefined });
    case "mission.message-member":
      if (!grant.memberId) return "this session is not a team member's, so it has no one to message from";
      return { missionId: grant.missionId, recipient: { kind: "member", memberId: text("memberId") ?? "" }, body: text("body") ?? "" };
    case "mission.ask": {
      if (!grant.memberId) return "this session is not a team member's, so it has no one to ask from";
      return defined({ missionId: grant.missionId, body: text("question") ?? "", workItemId: grant.workItemId });
    }
    case "mission.submit-handoff": {
      if (!grant.workItemId) return "this session serves no task, so it has nothing to hand off";
      const { summary, decisions, openQuestions, nextAction, referencedOutputs } = input;
      return { workItemId: grant.workItemId, notes: defined({ summary: summary as JsonValue, decisions: decisions as JsonValue | undefined, openQuestions: openQuestions as JsonValue | undefined, nextAction: nextAction as JsonValue | undefined, referencedOutputs: referencedOutputs as JsonValue | undefined }) };
    }
    case "mission.delegate":
      // The Governor takes the parent from the attempt's own session: the model names the sub-task, never a session.
      return defined({ missionId: grant.missionId, task: text("task") ?? "", memberId: text("memberId") });
    case "mission.comment": {
      const workItemId = text("workItemId") ?? grant.workItemId;
      if (!workItemId) return "this session serves no task: name the work item to comment on";
      return defined({ workItemId, text: text("text") ?? "", correctionOf: text("correctionOf") });
    }
    default:
      return `${toolId} is not a Brain tool`;
  }
}

/** What the model is told about the result: the new thing's id and, for a plan, whether it was confirmed or waits for a person. */
async function describe(toolId: string, resourceId: string | undefined, grant: SessionGrant, client: Client): Promise<JsonValue> {
  if (toolId === "mission.ask") return { recorded: true, ...(resourceId ? { id: resourceId } : {}), outcome: "A person has been asked. Their answer reaches you as a message from a person, in this session if it can take it, otherwise in your next one. Do not ask again and do not wait for it: carry on with what you can do, and say in your answer what depends on it." };
  if (toolId !== "mission.propose-plan" || !resourceId) return { recorded: true, ...(resourceId ? { id: resourceId } : {}) };
  const read = await client.actAs(grant.credential, "/v1/query", { queryType: "plans.get", workspaceId: grant.workspaceId, resourceId });
  const state = read.status === 200 ? String((read.json as { snapshot?: { state?: string } }).snapshot?.state ?? "") : "";
  if (state === "confirmed") return { recorded: true, planVersionId: resourceId, state, outcome: "This plan version was inside the mission's autonomy policy, so it is now the confirmed plan." };
  return { recorded: true, planVersionId: resourceId, state: state || "proposed", outcome: "This plan version is beyond the mission's autonomy policy (or the mission has no confirmed plan yet): it waits for a person to confirm it. Do not propose it again; carry on with your own task." };
}

function refusalOf(body: unknown, status: number): string {
  const error = (body as { detail?: unknown; error?: { detail?: unknown } } | null) ?? {};
  const detail = typeof error.detail === "string" ? error.detail : typeof error.error?.detail === "string" ? error.error.detail : undefined;
  return `${detail ?? `Brain refused the call (${status})`}. Do not retry this call unchanged; carry on without it and say in your answer what could not be done.`;
}

function sessionRefusal(error: unknown): string {
  const detail = (error as { body?: { detail?: unknown } } | null)?.body?.detail;
  return `${typeof detail === "string" ? detail : "this attempt cannot act on Brain"}. Brain tools work only inside a mission session.`;
}
