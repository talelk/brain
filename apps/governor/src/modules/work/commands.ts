import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { WorkService } from "./service";

/** Work commands: objectives, plan versions and work items. */
export function workCommands(work: WorkService): CommandHandlers {
  return handlersFor(["objective.create", "plan.propose", "plan.confirm", "workItem.transition", "workItem.comment"], {
    kind: "workspace",
    handle: ({ actor, cmd }) => ({ resourceId: work.apply(actor, cmd as Parameters<WorkService["apply"]>[1]) }),
  });
}
