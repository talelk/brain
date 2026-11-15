import type { Store } from "../../application/store";

/**
 * Who a chat user is in Brain (ADR 0011, amendment for spec #90 ticket #123). The signed inbound hook says which chat product a message
 * came from and who sent it; an administrator links that identity to one member. Nothing is linked by default and a chat message never
 * creates a link, so a chat user who is not linked has no authority at all.
 */
export const CHAT_PROVIDERS = ["slack", "teams", "brain"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export interface ChatIdentityView {
  readonly provider: ChatProvider;
  readonly chatUserId: string;
  readonly principalId: string;
  readonly name: string;
  readonly email: string;
  readonly active: boolean;
  readonly createdAt: string;
}

interface Row { provider: ChatProvider; chat_user_id: string; principal_id: string; created_at_ms: number; name: string | null; email: string | null; disabled_at_ms: number | null }

/** Every link of an organization, with the member it points at. */
export function listChatIdentities(store: Store, organizationId: string): ChatIdentityView[] {
  const rows = store.control.prepare(
    `SELECT c.provider, c.chat_user_id, c.principal_id, c.created_at_ms, u.name, u.email, p.disabled_at_ms
       FROM chat_identities c JOIN principals p ON p.id=c.principal_id AND p.organization_id=c.organization_id LEFT JOIN "user" u ON u.id=p.auth_subject_id
      WHERE c.organization_id=? ORDER BY c.provider, c.chat_user_id`).all(organizationId) as Row[];
  return rows.map((row) => ({ provider: row.provider, chatUserId: row.chat_user_id, principalId: row.principal_id, name: row.name ?? "", email: row.email ?? "", active: row.disabled_at_ms === null, createdAt: new Date(row.created_at_ms).toISOString() }));
}

/** The active human member a chat identity is linked to, if any. A suspended member's links stay but resolve to nobody. */
export function principalForChat(store: Store, organizationId: string, provider: ChatProvider, chatUserId: string): string | undefined {
  const row = store.control.prepare(
    `SELECT c.principal_id FROM chat_identities c JOIN principals p ON p.id=c.principal_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=? AND c.provider=? AND c.chat_user_id=? AND p.kind='human' AND p.disabled_at_ms IS NULL`).get(organizationId, provider, chatUserId) as { principal_id: string } | undefined;
  return row?.principal_id;
}

/** Links (or re-links) a chat identity to a member; false when the member is not an active human of the organization. */
export function setChatIdentity(store: Store, input: { organizationId: string; provider: ChatProvider; chatUserId: string; principalId: string; actorId: string }): boolean {
  const member = store.control.prepare("SELECT 1 AS ok FROM principals WHERE id=? AND organization_id=? AND kind='human' AND disabled_at_ms IS NULL").get(input.principalId, input.organizationId);
  if (!member) return false;
  store.control.prepare(`INSERT INTO chat_identities(organization_id,provider,chat_user_id,principal_id,created_by,created_at_ms) VALUES (?,?,?,?,?,?)
    ON CONFLICT(organization_id,provider,chat_user_id) DO UPDATE SET principal_id=excluded.principal_id,created_by=excluded.created_by,created_at_ms=excluded.created_at_ms`)
    .run(input.organizationId, input.provider, input.chatUserId, input.principalId, input.actorId, store.now());
  return true;
}

export function removeChatIdentity(store: Store, input: { organizationId: string; provider: ChatProvider; chatUserId: string }): boolean {
  return store.control.prepare("DELETE FROM chat_identities WHERE organization_id=? AND provider=? AND chat_user_id=?").run(input.organizationId, input.provider, input.chatUserId).changes === 1;
}
