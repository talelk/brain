// Relative imports: the browser project resolves no workspace packages from tests/.
import type { ActorContext, Mission } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";
import { actorOf, ensureAgentPrincipal } from "../../apps/governor/src/modules/identity/index";

/**
 * A mission with a confirmed one-member team whose member has asked a person a question, reached through commands: the person's commands as
 * themselves and the question as the member's own session principal (the credential's actor, as the Governor builds it for an attempt). Nothing
 * is started, so no runner is needed.
 */
export async function seedQuestion(brain: Brain, owner: ActorContext, workspaceId: string, input: { key: string; title: string; question: string }): Promise<{ missionId: string; questionId: string }> {
  const cmd = async (by: ActorContext, type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const { receipt } = await brain.executeCommand(by, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    if (!receipt.accepted) throw new Error(`${type} was refused: ${JSON.stringify(receipt.error)}`);
    return receipt.resourceId ?? "";
  };
  const missionId = await cmd(owner, "mission.create", `${input.key}-create`, { title: input.title, intent: input.title, successCriteria: ["The report is complete"], autoStart: false });
  const planId = await cmd(owner, "plan.propose", `${input.key}-plan`, {
    missionId, origin: "manual", team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }],
    tasks: [{ id: "draft", title: "Draft the report", criteria: ["A draft exists"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } }],
  });
  const version = ((await brain.executeQuery(owner, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await cmd(owner, "plan.confirm", `${input.key}-confirm`, { planVersionId: planId }, version);
  const binding = ensureAgentPrincipal(brain.store, { organizationId: owner.organizationId, workspaceId, missionId, memberId: "writer", actingFor: owner.actorId });
  const session = actorOf(binding, ["workspace:read", "mission:write"], "machine-credential", { attemptId: `attempt-${input.key}` });
  const questionId = await cmd(session, "mission.question.ask", `${input.key}-ask`, { missionId, body: input.question });
  return { missionId, questionId };
}
