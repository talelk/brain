import type { ActorContext, WorkItem } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";

/**
 * Records one eval case the way a person does: creates a mission with a one-task plan, starts the task, moves it to review and sends it
 * back with the reviewer's finding (ADR 0010: the case is saved by that transition, nothing writes the table). Everything goes through
 * `brain.executeCommand`. Returns the mission id.
 */
export async function sendTaskBack(brain: Brain, actor: ActorContext, workspaceId: string, input: { key: string; title: string; finding: string }): Promise<string> {
  const run = async (commandType: string, step: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const key = `${input.key}-${step}`;
    const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    if (!receipt.accepted) throw new Error(`eval case seed: ${commandType} (${step}) was refused`);
    return receipt.resourceId ?? "";
  };
  const missionId = await run("mission.create", "create", { title: input.title, intent: input.title, successCriteria: ["delivered"] });
  const planId = await run("plan.propose", "plan", { missionId, origin: "manual", tasks: [{ id: "write", title: `Write ${input.title}`, criteria: ["it is written"], dependsOn: [] }] });
  await run("plan.confirm", "confirm", { planVersionId: planId }, 1);
  const item = async (): Promise<WorkItem> => {
    const view = await brain.executeQuery(actor, { queryType: "workItems.list", workspaceId, limit: 100 }) as unknown as { snapshot: { items: WorkItem[] } };
    return view.snapshot.items.find((entry) => entry.missionId === missionId)!;
  };
  for (const state of ["in-progress", "review", "in-progress"]) {
    const current = await item();
    await run("workItem.transition", `${state}-${current.version}`, { workItemId: current.workItemId, state, ...(state === "in-progress" ? { reason: input.finding } : {}) }, current.version);
  }
  return missionId;
}
