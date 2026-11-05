import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { DocumentService } from "./service";

/** Document commands: uploads, revisions, associations and deletion. */
export function documentCommands(documents: DocumentService): CommandHandlers {
  return handlersFor(["document.upload", "document.revise", "document.associate", "document.delete"], {
    kind: "workspace",
    handle: ({ actor, cmd }) => ({ resourceId: documents.apply(actor, cmd as Parameters<DocumentService["apply"]>[1]) }),
  });
}
