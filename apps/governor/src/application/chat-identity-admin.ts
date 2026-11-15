import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { listChatIdentities, removeChatIdentity, setChatIdentity, type ChatProvider } from "../modules/identity/index";
import type { CommandHandlers } from "./command-funnel";
import type { Store } from "./store";

/**
 * Administration of chat identities (ADR 0011 amendment): `chatIdentity.set` links what the signed chat hook says about a sender to one
 * member, `chatIdentity.remove` unlinks it, `chatIdentities.list` shows the links. Only an identity security administrator links people:
 * the link is what lets a chat message start work with that member's authority.
 */
export function chatIdentityCommands(store: Store): CommandHandlers {
  const admin = (actor: ActorContext): void => {
    if (actor.kind !== "human" || !actor.scopes.includes("identity:security")) throw new BrainDomainError("FORBIDDEN", "chat identities are linked by an identity security administrator");
  };
  return {
    "chatIdentity.set": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        admin(actor);
        const p = cmd.payload;
        const provider = p["provider"] as ChatProvider;
        const chatUserId = String(p["chatUserId"]).trim();
        if (!chatUserId) throw new BrainDomainError("INVALID_ARGUMENT", "the chat user id is required");
        const principalId = String(p["principalId"]);
        if (!setChatIdentity(store, { organizationId: actor.organizationId, provider, chatUserId, principalId, actorId: actor.actorId })) throw new BrainDomainError("NOT_FOUND", "organization member not found");
        store.emit(store.control, { organizationId: actor.organizationId, aggregateType: "platform", aggregateId: "chat-identities", eventType: "chatIdentity.set", payload: { provider, chatUserId, principalId } });
        return { resourceId: `${provider}:${chatUserId}` };
      },
    },
    "chatIdentity.remove": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        admin(actor);
        const provider = cmd.payload["provider"] as ChatProvider;
        const chatUserId = String(cmd.payload["chatUserId"]);
        if (!removeChatIdentity(store, { organizationId: actor.organizationId, provider, chatUserId })) throw new BrainDomainError("NOT_FOUND", "that chat identity is not linked");
        store.emit(store.control, { organizationId: actor.organizationId, aggregateType: "platform", aggregateId: "chat-identities", eventType: "chatIdentity.removed", payload: { provider, chatUserId } });
        return { resourceId: `${provider}:${chatUserId}` };
      },
    },
  };
}

/** chatIdentities.list: the links of the organization. */
export function chatIdentitiesQuery(store: Store, actor: ActorContext): JsonValue {
  if (actor.kind !== "human" || !actor.scopes.includes("identity:read")) throw new BrainDomainError("FORBIDDEN", "identity administration read scope required");
  return { identities: listChatIdentities(store, actor.organizationId) } as unknown as JsonValue;
}
