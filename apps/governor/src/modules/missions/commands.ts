import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { MissionService } from "./service";

/** Mission commands: missions, plan versions and work items. */
export function missionCommands(missions: MissionService): CommandHandlers {
  return handlersFor(["mission.create", "plan.propose", "plan.confirm", "workItem.transition", "workItem.comment"], {
    kind: "workspace",
    handle: ({ actor, cmd }) => ({ resourceId: missions.apply(actor, cmd as Parameters<MissionService["apply"]>[1]) }),
  });
}
