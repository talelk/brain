import { BrainError, hmacSha256Hex, type AccessRow, type Grants, type GroupRow, type Role, type SessionRow, type SignInRow, type UserDetail, type UserRow } from "@brain/contracts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Governor } from "../app";
import type { Ctx, Gov } from "../dispatch";
import { append } from "../events";
import { mailConfigured, sendMail } from "./mail";

// Users, invitations, groups and sessions (docs/model.md, Users, invitations and groups). Every command appends its audit event in its own transaction.

const DAY_MS = 24 * 3600_000;
const INVITE_MS = 7 * DAY_MS;
const RESET_MS = DAY_MS;
const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3 };

const digestOf = (gov: Gov, token: string): string => hmacSha256Hex(gov.keys.digests, Buffer.from(token));
const newToken = (): string => randomBytes(32).toString("base64url");
/** The token travels in the address fragment, which a browser never sends to a server, so it reaches no log. */
const linkOf = (gov: Gov, kind: "invite" | "reset", token: string): string => `${gov.baseUrl.replace(/\/+$/u, "")}/#${kind}=${token}`;
/** better-auth keeps its dates as text or numbers, depending on the column. */
const ms = (value: unknown): number => (typeof value === "number" ? value : new Date(String(value)).getTime());

/** At most `max` refusals in a minute, per key: the answer to a guessed token or password, which better-auth's own limiter does not see. */
const refusals = new WeakMap<Gov, Map<string, number[]>>();
function recent(gov: Gov, key: string, now: number): number[] {
  const all = refusals.get(gov) ?? new Map<string, number[]>();
  refusals.set(gov, all);
  const kept = (all.get(key) ?? []).filter((at) => now - at < 60_000);
  if (kept.length > 0) all.set(key, kept);
  else all.delete(key);
  return kept;
}
const assertNotLimited = (gov: Gov, key: string, now: number, max: number): void => {
  if (recent(gov, key, now).length >= max) throw new BrainError("CONFLICT", "Too many attempts: wait a minute and try again");
};
const noteRefusal = (gov: Gov, key: string, now: number): void => {
  const kept = recent(gov, key, now);
  kept.push(now);
  refusals.get(gov)?.set(key, kept);
};
const invalidLink = (): BrainError => new BrainError("NOT_FOUND", "This link is not valid, or it has expired or been used");

const activeAdmins = (ctx: Ctx): number => (ctx.db.prepare("SELECT COUNT(*) AS n FROM instance_admins a WHERE NOT EXISTS (SELECT 1 FROM deactivated_users d WHERE d.user_id = a.user_id)").get() as { n: number }).n;
const isAdmin = (ctx: Ctx, userId: string): boolean => ctx.db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(userId) !== undefined;
const isActive = (ctx: Ctx, userId: string): boolean => ctx.db.prepare("SELECT 1 FROM deactivated_users WHERE user_id=?").get(userId) === undefined;
const person = (ctx: Ctx, userId: string): { id: string; name: string; email: string } => {
  const row = ctx.db.prepare('SELECT id, name, email FROM "user" WHERE id=?').get(userId) as { id: string; name: string; email: string } | undefined;
  if (!row) throw new BrainError("NOT_FOUND", "There is no such person");
  return row;
};

/** Deletes a person's sessions (all, or all but one), which ends them at once: sessions are read from the table on every request. Their event streams end too. */
function endSessions(ctx: Ctx, userId: string, keep?: string, only?: string): number {
  const where = [`"userId"=?`, ...(keep ? ["id<>?"] : []), ...(only ? ["id=?"] : [])].join(" AND ");
  const { changes } = ctx.db.prepare(`DELETE FROM session WHERE ${where}`).run(userId, ...(keep ? [keep] : []), ...(only ? [only] : []));
  for (const ended of ctx.gov.onSignedOut) ended(userId);
  return changes;
}

interface Link { readonly id: string; readonly kind: "invite" | "reset"; readonly email: string; readonly userId: string | null; readonly grants: Grants }
function pending(gov: Gov, token: string): Link | undefined {
  const row = gov.db.prepare("SELECT id, kind, email, user_id AS userId, grants_json AS grants FROM invitations WHERE token_digest=? AND state='pending' AND expires_at_ms>?").get(digestOf(gov, token), gov.clock.nowMs()) as (Omit<Link, "grants"> & { grants: string }) | undefined;
  return row ? { ...row, grants: JSON.parse(row.grants) as Grants } : undefined;
}

const NO_GRANTS: Grants = { instanceAdmin: false, workspaces: [], groups: [] };

/** Gives a new person what their invitation granted; a workspace or group that is gone since is skipped. */
function applyGrants(ctx: Ctx, actor: Ctx["actor"], userId: string, grants: Grants): void {
  if (grants.instanceAdmin) ctx.db.prepare("INSERT OR IGNORE INTO instance_admins(user_id, created_at_ms) VALUES (?,?)").run(userId, ctx.now());
  for (const grant of grants.workspaces) {
    if (!ctx.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(grant.workspaceId)) continue;
    ctx.db.prepare("INSERT OR IGNORE INTO members(workspace_id, user_id, role, created_at_ms) VALUES (?,?,?,?)").run(grant.workspaceId, userId, grant.role, ctx.now());
    append(ctx.db, { type: "member.set", workspaceId: grant.workspaceId, subject: `user:${userId}`, payload: { userId, role: grant.role, created: true }, actor });
  }
  for (const groupId of grants.groups) ctx.db.prepare("INSERT INTO group_members(group_id, user_id) SELECT id, ? FROM groups WHERE id=? ON CONFLICT DO NOTHING").run(userId, groupId);
}

function mailLink(to: string, kind: "invite" | "reset", link: string): void {
  const text = kind === "invite" ? `You have been invited to Brain.\n\nOpen this link to choose your name and password. It works once.\n\n${link}\n` : `An administrator of Brain made a link for you to choose a new password. It works once.\n\n${link}\n`;
  // After the command's transaction has ended, and without holding the answer back.
  setImmediate(() => void sendMail(to, kind === "invite" ? "You are invited to Brain" : "Choose a new password for Brain", text));
}

export function registerUsers({ gov: { registry } }: Governor): void {
  registry.command<"user.invite">("user.invite", {
    secretOutput: true,
    run(ctx, input) {
      if (ctx.gov.auth.find(input.email)) throw new BrainError("CONFLICT", "This address already has an account");
      for (const grant of input.workspaces) if (!ctx.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(grant.workspaceId)) throw new BrainError("INVALID_INPUT", "A workspace of the invitation does not exist", [{ path: "workspaces", message: grant.workspaceId }]);
      for (const groupId of input.groups) if (!ctx.db.prepare("SELECT 1 FROM groups WHERE id=?").get(groupId)) throw new BrainError("INVALID_INPUT", "A group of the invitation does not exist", [{ path: "groups", message: groupId }]);
      const replaced = (ctx.db.prepare("SELECT id FROM invitations WHERE email=? AND kind='invite' AND state='pending'").all(input.email) as Array<{ id: string }>).map((row) => row.id);
      ctx.db.prepare("UPDATE invitations SET state='revoked' WHERE email=? AND kind='invite' AND state='pending'").run(input.email);
      const token = newToken();
      const id = `inv_${randomUUID()}`;
      const expiresAt = ctx.now() + INVITE_MS;
      const grants: Grants = { instanceAdmin: input.instanceAdmin, workspaces: input.workspaces, groups: input.groups };
      ctx.db.prepare("INSERT INTO invitations(id, kind, email, token_digest, grants_json, created_by, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?)").run(id, "invite", input.email, digestOf(ctx.gov, token), JSON.stringify(grants), ctx.user?.id ?? "", ctx.now(), expiresAt);
      append(ctx.db, { type: "user.invited", subject: `invitation:${id}`, payload: { invitationId: id, email: input.email, ...grants, replaced }, actor: ctx.actor });
      const link = linkOf(ctx.gov, "invite", token);
      mailLink(input.email, "invite", link);
      return { invitationId: id, link, expiresAt, emailed: mailConfigured() };
    },
  });

  registry.command("invitation.revoke", (ctx, input) => {
    const row = ctx.db.prepare("SELECT email, kind FROM invitations WHERE id=? AND state='pending'").get(input.invitationId) as { email: string; kind: string } | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "There is no pending invitation like this");
    ctx.db.prepare("UPDATE invitations SET state='revoked' WHERE id=?").run(input.invitationId);
    append(ctx.db, { type: "user.invitation_revoked", subject: `invitation:${input.invitationId}`, payload: { invitationId: input.invitationId, email: row.email, kind: row.kind }, actor: ctx.actor });
    return {};
  });

  // The one public entry here: the token is the credential. A refusal says the same whatever is wrong with it, and refusals are limited per address.
  registry.command<"invitation.accept", { link: Link; userId: string; cookies: string[]; hash: string }>("invitation.accept", {
    async prepare(ctx, input) {
      const key = `link:${ctx.ip}`;
      assertNotLimited(ctx.gov, key, ctx.now(), 10);
      const link = pending(ctx.gov, input.token);
      if (!link) {
        noteRefusal(ctx.gov, key, ctx.now());
        throw invalidLink();
      }
      if (link.kind === "reset") return { link, userId: link.userId ?? "", cookies: [], hash: await ctx.gov.auth.hashPassword(input.password) };
      if (!input.name) throw new BrainError("INVALID_INPUT", "Say what to call you", [{ path: "name", message: "needed to join" }]);
      // An address that got an account some other way since the invitation was made cannot be invited a second time.
      if (ctx.gov.auth.find(link.email)) throw invalidLink();
      const userId = await ctx.gov.auth.createAccount({ email: link.email, name: input.name, password: input.password });
      return { link, userId, cookies: (await ctx.gov.auth.signIn(link.email, input.password)).cookies, hash: "" };
    },
    run(ctx, input, prepared) {
      const link = pending(ctx.gov, input.token);
      if (!link || link.id !== prepared.link.id) throw invalidLink();
      ctx.db.prepare("UPDATE invitations SET state='used', used_at_ms=? WHERE id=?").run(ctx.now(), link.id);
      const actor = { kind: "person", id: prepared.userId } as const;
      if (link.kind === "reset") {
        ctx.db.prepare(`UPDATE account SET password=?, "updatedAt"=? WHERE "userId"=? AND "providerId"='credential'`).run(prepared.hash, new Date(ctx.now()).toISOString(), prepared.userId);
        endSessions(ctx, prepared.userId);
        append(ctx.db, { type: "user.password_reset", subject: `user:${prepared.userId}`, payload: { userId: prepared.userId, invitationId: link.id }, actor });
        return { kind: "reset", userId: prepared.userId };
      }
      applyGrants(ctx, actor, prepared.userId, link.grants);
      append(ctx.db, { type: "user.joined", subject: `user:${prepared.userId}`, payload: { userId: prepared.userId, email: link.email, invitationId: link.id, ...link.grants }, actor });
      ctx.cookies.push(...prepared.cookies);
      return { kind: "invite", userId: prepared.userId };
    },
  });

  registry.command("user.set", (ctx, input) => {
    const target = person(ctx, input.userId);
    const wasAdmin = isAdmin(ctx, target.id);
    const wasActive = isActive(ctx, target.id);
    // The last active instance admin stays one, and active: otherwise nobody could look after the people or the workspaces again.
    const lastAdmin = wasAdmin && wasActive && activeAdmins(ctx) <= 1;
    if (input.instanceAdmin === false && wasAdmin && lastAdmin) throw new BrainError("CONFLICT", "Brain keeps at least one active instance admin");
    if (input.active === false && wasActive) {
      if (target.id === ctx.user?.id) throw new BrainError("CONFLICT", "Ask another admin to deactivate you");
      if (lastAdmin) throw new BrainError("CONFLICT", "Brain keeps at least one active instance admin");
    }
    if (input.instanceAdmin !== undefined && input.instanceAdmin !== wasAdmin) {
      if (input.instanceAdmin) ctx.db.prepare("INSERT INTO instance_admins(user_id, created_at_ms) VALUES (?,?)").run(target.id, ctx.now());
      else ctx.db.prepare("DELETE FROM instance_admins WHERE user_id=?").run(target.id);
      append(ctx.db, { type: "user.role_set", subject: `user:${target.id}`, payload: { userId: target.id, instanceAdmin: input.instanceAdmin }, actor: ctx.actor });
    }
    if (input.active === false && wasActive) {
      ctx.db.prepare("INSERT INTO deactivated_users(user_id, at_ms, by_user_id) VALUES (?,?,?)").run(target.id, ctx.now(), ctx.user?.id ?? "");
      const ended = endSessions(ctx, target.id);
      append(ctx.db, { type: "user.deactivated", subject: `user:${target.id}`, payload: { userId: target.id, sessionsEnded: ended }, actor: ctx.actor });
    } else if (input.active === true && !wasActive) {
      ctx.db.prepare("DELETE FROM deactivated_users WHERE user_id=?").run(target.id);
      append(ctx.db, { type: "user.reactivated", subject: `user:${target.id}`, payload: { userId: target.id }, actor: ctx.actor });
    }
    return {};
  });

  registry.command<"user.resetLink">("user.resetLink", {
    secretOutput: true,
    run(ctx, input) {
      const target = person(ctx, input.userId);
      ctx.db.prepare("UPDATE invitations SET state='revoked' WHERE user_id=? AND kind='reset' AND state='pending'").run(target.id);
      const token = newToken();
      const id = `inv_${randomUUID()}`;
      const expiresAt = ctx.now() + RESET_MS;
      ctx.db.prepare("INSERT INTO invitations(id, kind, email, user_id, token_digest, grants_json, created_by, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "reset", target.email, target.id, digestOf(ctx.gov, token), JSON.stringify(NO_GRANTS), ctx.user?.id ?? "", ctx.now(), expiresAt);
      append(ctx.db, { type: "user.reset_issued", subject: `user:${target.id}`, payload: { userId: target.id, invitationId: id }, actor: ctx.actor });
      const link = linkOf(ctx.gov, "reset", token);
      mailLink(target.email, "reset", link);
      return { link, expiresAt };
    },
  });

  registry.command("session.revoke", (ctx, input) => {
    const me = ctx.user;
    if (!me) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const userId = input.userId ?? me.id;
    if (userId !== me.id && !me.instanceAdmin) throw new BrainError("FORBIDDEN", "This needs an administrator of this Brain");
    person(ctx, userId);
    const revoked = endSessions(ctx, userId, input.keepCurrent && userId === me.id ? me.sessionId : undefined, input.sessionId);
    append(ctx.db, { type: "user.signed_out", subject: `user:${userId}`, payload: { userId, sessions: revoked, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, actor: ctx.actor });
    return { revoked };
  });

  registry.command<"profile.set", { hash: string }>("profile.set", {
    async prepare(ctx, input) {
      const me = ctx.user;
      if (!me) throw new BrainError("UNAUTHENTICATED", "Sign in first");
      if (input.newPassword === undefined || input.currentPassword === undefined) return { hash: "" };
      const key = `password:${me.id}`;
      assertNotLimited(ctx.gov, key, ctx.now(), 5);
      if (!(await ctx.gov.auth.verifyPassword(me.id, input.currentPassword))) {
        noteRefusal(ctx.gov, key, ctx.now());
        throw new BrainError("FORBIDDEN", "The current password is wrong", [{ path: "currentPassword", message: "wrong" }]);
      }
      return { hash: await ctx.gov.auth.hashPassword(input.newPassword) };
    },
    run(ctx, input, { hash }) {
      const me = ctx.user;
      if (!me) throw new BrainError("UNAUTHENTICATED", "Sign in first");
      if (input.name !== undefined) ctx.db.prepare(`UPDATE "user" SET name=?, "updatedAt"=? WHERE id=?`).run(input.name, new Date(ctx.now()).toISOString(), me.id);
      if (hash) {
        ctx.db.prepare(`UPDATE account SET password=?, "updatedAt"=? WHERE "userId"=? AND "providerId"='credential'`).run(hash, new Date(ctx.now()).toISOString(), me.id);
        endSessions(ctx, me.id, me.sessionId);
      }
      append(ctx.db, { type: "user.profile_set", subject: `user:${me.id}`, payload: { userId: me.id, name: input.name !== undefined, password: hash !== "" }, actor: ctx.actor });
      return {};
    },
  });

  registry.command("group.set", (ctx, input) => {
    const clash = ctx.db.prepare("SELECT 1 FROM groups WHERE name=? AND id<>?").get(input.name, input.groupId ?? "");
    if (clash) throw new BrainError("CONFLICT", "A group has this name already", [{ path: "name", message: "taken" }]);
    for (const userId of input.memberIds) person(ctx, userId);
    for (const grant of input.grants) if (!ctx.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(grant.workspaceId)) throw new BrainError("INVALID_INPUT", "A workspace of the group does not exist", [{ path: "grants", message: grant.workspaceId }]);
    const created = !input.groupId;
    const groupId = input.groupId ?? `grp_${randomUUID()}`;
    if (created) ctx.db.prepare("INSERT INTO groups(id, name, created_at_ms) VALUES (?,?,?)").run(groupId, input.name, ctx.now());
    else if (ctx.db.prepare("UPDATE groups SET name=? WHERE id=?").run(input.name, groupId).changes === 0) throw new BrainError("NOT_FOUND", "There is no such group");

    const before = new Set((ctx.db.prepare("SELECT user_id AS id FROM group_members WHERE group_id=?").all(groupId) as Array<{ id: string }>).map((row) => row.id));
    const after = new Set(input.memberIds);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    for (const id of added) ctx.db.prepare("INSERT INTO group_members(group_id, user_id) VALUES (?,?)").run(groupId, id);
    for (const id of removed) ctx.db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(groupId, id);

    const had = new Map((ctx.db.prepare("SELECT workspace_id AS id, role FROM group_grants WHERE group_id=?").all(groupId) as Array<{ id: string; role: Role }>).map((row) => [row.id, row.role]));
    const wants = new Map(input.grants.map((grant) => [grant.workspaceId, grant.role] as const));
    append(ctx.db, { type: created ? "group.created" : "group.updated", subject: `group:${groupId}`, payload: { groupId, name: input.name, added, removed }, actor: ctx.actor });
    for (const [workspaceId, role] of had) {
      if (wants.get(workspaceId) === role) continue;
      ctx.db.prepare("DELETE FROM group_grants WHERE group_id=? AND workspace_id=?").run(groupId, workspaceId);
      if (!wants.has(workspaceId)) append(ctx.db, { type: "group.revoked", workspaceId, subject: `group:${groupId}`, payload: { groupId, role }, actor: ctx.actor });
    }
    for (const [workspaceId, role] of wants) {
      if (had.get(workspaceId) === role) continue;
      ctx.db.prepare("INSERT INTO group_grants(group_id, workspace_id, role) VALUES (?,?,?)").run(groupId, workspaceId, role);
      append(ctx.db, { type: "group.granted", workspaceId, subject: `group:${groupId}`, payload: { groupId, role, previous: had.get(workspaceId) ?? null }, actor: ctx.actor });
    }
    return { groupId };
  });

  registry.command("group.delete", (ctx, input) => {
    const group = ctx.db.prepare("SELECT name FROM groups WHERE id=?").get(input.groupId) as { name: string } | undefined;
    if (!group) throw new BrainError("NOT_FOUND", "There is no such group");
    for (const grant of ctx.db.prepare("SELECT workspace_id AS workspaceId, role FROM group_grants WHERE group_id=?").all(input.groupId) as Array<{ workspaceId: string; role: Role }>) {
      append(ctx.db, { type: "group.revoked", workspaceId: grant.workspaceId, subject: `group:${input.groupId}`, payload: { groupId: input.groupId, role: grant.role }, actor: ctx.actor });
    }
    ctx.db.prepare("DELETE FROM groups WHERE id=?").run(input.groupId);
    append(ctx.db, { type: "group.deleted", subject: `group:${input.groupId}`, payload: { groupId: input.groupId, name: group.name }, actor: ctx.actor });
    return {};
  });

  registry.query("users.list", (ctx) => {
    const db = ctx.db;
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u."createdAt" AS createdAt, a.user_id IS NOT NULL AS admin, d.user_id IS NOT NULL AS off,
      (SELECT MAX(created_at_ms) FROM events WHERE subject = 'user:' || u.id AND type = 'user.signed_in') AS lastSignInAt
      FROM "user" u LEFT JOIN instance_admins a ON a.user_id = u.id LEFT JOIN deactivated_users d ON d.user_id = u.id ORDER BY u.name COLLATE NOCASE, u.email`).all() as Array<{ id: string; name: string; email: string; createdAt: unknown; admin: number; off: number; lastSignInAt: number | null }>;
    const groupsOf = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of db.prepare("SELECT gm.user_id AS userId, g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id ORDER BY g.name COLLATE NOCASE").all() as Array<{ userId: string; id: string; name: string }>) groupsOf.set(row.userId, [...(groupsOf.get(row.userId) ?? []), { id: row.id, name: row.name }]);
    const reach = new Map((db.prepare(`SELECT user_id AS userId, COUNT(*) AS n FROM (SELECT user_id, workspace_id FROM members UNION SELECT gm.user_id, gg.workspace_id FROM group_members gm JOIN group_grants gg ON gg.group_id = gm.group_id) GROUP BY user_id`).all() as Array<{ userId: string; n: number }>).map((row) => [row.userId, row.n]));
    const users: UserRow[] = rows.map((row) => ({
      id: row.id, name: row.name, email: row.email, status: row.off ? "deactivated" : "active", instanceAdmin: row.admin === 1, groups: groupsOf.get(row.id) ?? [], workspaces: reach.get(row.id) ?? 0,
      lastSignInAt: row.lastSignInAt, createdAt: ms(row.createdAt),
    }));
    const invited = (db.prepare("SELECT id, email, grants_json AS grants, created_at_ms AS createdAt, expires_at_ms AS expiresAt FROM invitations WHERE kind='invite' AND state='pending' ORDER BY created_at_ms DESC").all() as Array<{ id: string; email: string; grants: string; createdAt: number; expiresAt: number }>).map((row): UserRow => {
      const grants = JSON.parse(row.grants) as Grants;
      const names = new Map((db.prepare("SELECT id, name FROM groups").all() as Array<{ id: string; name: string }>).map((group) => [group.id, group.name]));
      return {
        id: row.id, name: "", email: row.email, status: "invited", instanceAdmin: grants.instanceAdmin, groups: grants.groups.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id) ?? "" }] : [])), workspaces: grants.workspaces.length,
        lastSignInAt: null, createdAt: row.createdAt, invitationId: row.id, expiresAt: row.expiresAt, grants,
      };
    });
    const groups: GroupRow[] = (db.prepare("SELECT id, name FROM groups ORDER BY name COLLATE NOCASE").all() as Array<{ id: string; name: string }>).map((group) => ({
      id: group.id, name: group.name,
      members: db.prepare(`SELECT u.id AS userId, u.name, u.email FROM group_members gm JOIN "user" u ON u.id = gm.user_id WHERE gm.group_id=? ORDER BY u.name COLLATE NOCASE`).all(group.id) as GroupRow["members"],
      grants: db.prepare("SELECT gg.workspace_id AS workspaceId, w.name, gg.role FROM group_grants gg JOIN workspaces w ON w.id = gg.workspace_id WHERE gg.group_id=? ORDER BY w.name COLLATE NOCASE").all(group.id) as GroupRow["grants"],
    }));
    return { users: [...users, ...invited], groups, workspaces: db.prepare("SELECT id, name FROM workspaces WHERE status='active' ORDER BY name COLLATE NOCASE").all() as Array<{ id: string; name: string }> };
  });

  registry.query("user.get", (ctx, input) => {
    const me = ctx.user;
    if (!me) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const userId = input.userId ?? me.id;
    if (userId !== me.id && !me.instanceAdmin) throw new BrainError("FORBIDDEN", "This needs an administrator of this Brain");
    const db = ctx.db;
    const row = db.prepare(`SELECT id, name, email, "createdAt" AS createdAt FROM "user" WHERE id=?`).get(userId) as { id: string; name: string; email: string; createdAt: unknown } | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "There is no such person");
    const lastSignInAt = (db.prepare("SELECT MAX(created_at_ms) AS at FROM events WHERE subject=? AND type='user.signed_in'").get(`user:${userId}`) as { at: number | null }).at;
    const sessions = (db.prepare(`SELECT id, "createdAt" AS createdAt, "expiresAt" AS expiresAt, "ipAddress" AS ipAddress, "userAgent" AS userAgent FROM session WHERE "userId"=? ORDER BY "createdAt" DESC`).all(userId) as Array<{ id: string; createdAt: unknown; expiresAt: unknown; ipAddress: string | null; userAgent: string | null }>)
      .map((session): SessionRow => ({ id: session.id, createdAt: ms(session.createdAt), expiresAt: ms(session.expiresAt), ipAddress: session.ipAddress, userAgent: session.userAgent, current: session.id === me.sessionId }))
      .filter((session) => session.expiresAt > ctx.now());
    const signIns = (db.prepare("SELECT type, created_at_ms AS at, payload_json AS payload FROM events WHERE subject=? AND type IN ('user.signed_in','user.sign_in_failed') ORDER BY seq DESC LIMIT 30").all(`user:${userId}`) as Array<{ type: string; at: number; payload: string }>)
      .map((event): SignInRow => {
        const payload = JSON.parse(event.payload) as { ipAddress?: string | null; userAgent?: string | null };
        return { at: event.at, ok: event.type === "user.signed_in", ipAddress: payload.ipAddress ?? null, userAgent: payload.userAgent ?? null };
      });
    const grants = db.prepare(`SELECT w.id AS workspaceId, w.slug, w.name, g.id AS groupId, g.name AS groupName, gg.role FROM group_members gm JOIN group_grants gg ON gg.group_id = gm.group_id JOIN groups g ON g.id = gg.group_id JOIN workspaces w ON w.id = gg.workspace_id WHERE gm.user_id=?`).all(userId) as Array<{ workspaceId: string; slug: string; name: string; groupId: string; groupName: string; role: Role }>;
    const direct = db.prepare("SELECT w.id AS workspaceId, w.slug, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id=?").all(userId) as Array<{ workspaceId: string; slug: string; name: string; role: Role }>;
    const matrix = new Map<string, { slug: string; name: string; direct: Role | null; groups: Array<{ id: string; name: string; role: Role }> }>();
    for (const entry of direct) matrix.set(entry.workspaceId, { slug: entry.slug, name: entry.name, direct: entry.role, groups: [] });
    for (const entry of grants) {
      const slot = matrix.get(entry.workspaceId) ?? { slug: entry.slug, name: entry.name, direct: null, groups: [] };
      slot.groups.push({ id: entry.groupId, name: entry.groupName, role: entry.role });
      matrix.set(entry.workspaceId, slot);
    }
    const access = [...matrix].map(([workspaceId, slot]): AccessRow => ({
      workspaceId, slug: slot.slug, name: slot.name, direct: slot.direct, groups: slot.groups,
      role: [...(slot.direct ? [slot.direct] : []), ...slot.groups.map((group) => group.role)].reduce((best, role) => (RANK[role] > RANK[best] ? role : best)),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const detail: UserDetail = {
      user: { id: row.id, name: row.name, email: row.email, status: db.prepare("SELECT 1 FROM deactivated_users WHERE user_id=?").get(userId) ? "deactivated" : "active", instanceAdmin: db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(userId) !== undefined, createdAt: ms(row.createdAt), lastSignInAt },
      groups: db.prepare("SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id=? ORDER BY g.name COLLATE NOCASE").all(userId) as Array<{ id: string; name: string }>,
      sessions, signIns, access,
    };
    return detail;
  });
}
