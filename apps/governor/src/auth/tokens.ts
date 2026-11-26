import { BrainError, hmacSha256Hex, type ApiToken, type TokenRole, type User } from "@brain/contracts";
import { randomBytes } from "node:crypto";
import type { Governor } from "../app";
import type { Db } from "../db";
import { append } from "../events";
import { newId } from "../tasks/store";
import { manifestOf, getWorkspace } from "../workspace/store";

/**
 * API tokens (docs/model.md, "API tokens"): the credential of another system, for one workspace, as a viewer or a member. A token calls as
 * a principal of its own, `token:<id>`, which every place that asks who may see a workspace answers like a person who holds that one role.
 * What a token may never do is decided where commands are authorized (dispatch.ts).
 */
const PREFIX = "brn_";
const DAY_MS = 86_400_000;
const TOKEN_ID_PREFIX = "token:";
export const isTokenId = (userId: string): boolean => userId.startsWith(TOKEN_ID_PREFIX);

const digestOf = (key: Buffer, token: string): string => hmacSha256Hex(key, Buffer.from(`api-token\n${token}`));

interface Row { readonly id: string; readonly workspace_id: string; readonly name: string; readonly role: TokenRole }
const LIVE = "revoked_at_ms IS NULL AND expires_at_ms > ?";

/** The role and workspace of a token's principal, while the token holds. */
export function tokenGrant(db: Db, userId: string, now: number): { readonly workspaceId: string; readonly role: TokenRole } | undefined {
  const row = db.prepare(`SELECT id, workspace_id, name, role FROM api_tokens WHERE id=? AND ${LIVE}`).get(userId.slice(TOKEN_ID_PREFIX.length), now) as Row | undefined;
  return row ? { workspaceId: row.workspace_id, role: row.role } : undefined;
}

/**
 * Who a request's `authorization` header names: undefined when it carries no API token (a session is looked for instead), null when the
 * token it carries is unknown, revoked or expired.
 */
export function tokenUser(db: Db, key: Buffer, now: number, headers: Headers): User | null | undefined {
  const found = /^Bearer[ \t]+(\S+)$/iu.exec(headers.get("authorization") ?? "")?.[1];
  if (!found?.startsWith(PREFIX)) return undefined;
  const row = db.prepare(`SELECT id, workspace_id, name, role FROM api_tokens WHERE token_digest=? AND ${LIVE}`).get(digestOf(key, found), now) as Row | undefined;
  return row ? { id: `${TOKEN_ID_PREFIX}${row.id}`, name: row.name, email: "", instanceAdmin: false, sessionId: "" } : null;
}

export function registerTokens({ gov }: Governor): void {
  const { registry } = gov;
  registry.command("token.create", {
    secretOutput: true,
    run: (ctx, input) => {
      const workspace = getWorkspace(ctx.db, input.workspaceId);
      if (manifestOf(ctx.gov, workspace.snapshotDigest).platform) throw new BrainError("CONFLICT", "A platform workspace is seen by this Brain's administrators only: it takes no token");
      const id = newId("tok");
      const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = ctx.now() + input.days * DAY_MS;
      ctx.db.prepare("INSERT INTO api_tokens(id, workspace_id, name, role, token_digest, created_by, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, input.workspaceId, input.name, input.role, digestOf(ctx.gov.keys.digests, token), ctx.actor.id, ctx.now(), expiresAt);
      append(ctx.db, { type: "token.created", workspaceId: input.workspaceId, subject: `token:${id}`, payload: { name: input.name, role: input.role, expiresAt }, actor: ctx.actor });
      return { tokenId: id, token, expiresAt };
    },
  });
  registry.command("token.revoke", (ctx, input) => {
    const changed = ctx.db.prepare("UPDATE api_tokens SET revoked_at_ms=? WHERE id=? AND workspace_id=? AND revoked_at_ms IS NULL").run(ctx.now(), input.tokenId, input.workspaceId).changes;
    if (changed === 0) throw new BrainError("NOT_FOUND", "Token not found");
    append(ctx.db, { type: "token.revoked", workspaceId: input.workspaceId, subject: `token:${input.tokenId}`, payload: {}, actor: ctx.actor });
    return {};
  });
  registry.query("tokens.list", (ctx, input) => ({
    tokens: ctx.db.prepare(`SELECT t.id, t.name, t.role, u.name AS createdByName, t.created_at_ms AS createdAt, t.expires_at_ms AS expiresAt, t.revoked_at_ms AS revokedAt
      FROM api_tokens t LEFT JOIN "user" u ON u.id = t.created_by WHERE t.workspace_id=? ORDER BY t.created_at_ms DESC, t.id`).all(input.workspaceId) as ApiToken[],
  }));
}
