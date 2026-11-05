import type { CommandHandler, CommandHandlers } from "../../application/command-funnel";
import type { Store } from "../../application/store";
import { activateRelease } from "./activation";
import type { ConfigurationDraftService } from "./drafts";

/** Configuration commands: release activation and Studio drafts (control.db). */
export function configurationCommands(store: Store, drafts: ConfigurationDraftService): CommandHandlers {
  const draft = (outcome: "applied" | "queued"): CommandHandler => ({
    kind: "control",
    handle: ({ actor, cmd }) => ({ outcome, resourceId: drafts.apply(actor, cmd as Parameters<ConfigurationDraftService["apply"]>[1]) }),
  });
  return {
    "config.activate": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        const p = cmd.payload;
        const expected = p["expectedActiveDigest"];
        activateRelease(store, actor, String(p["configDigest"]), expected === undefined ? undefined : expected === null ? null : String(expected));
        return { resourceId: String(p["configDigest"]) };
      },
    },
    "configDraft.create": draft("applied"),
    "configDraft.update": draft("applied"),
    "configDraft.validate": draft("applied"),
    "configDraft.test": draft("applied"),
    "configDraft.publish": draft("applied"),
  };
}
