import { BrainError, hmacSha256Hex, type CommandInput, type Role } from "@brain/contracts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWorkspaces } from "../access";
import { getInstance, setInstance, type Db } from "../db";
import type { Governor } from "../app";
import type { Gov } from "../dispatch";
import { append } from "../events";
import { commitNewWorkspace, createWorkspace, starterWorkspace, type NewWorkspace } from "../workspace/handlers";

const tokenPath = (dataDir: string): string => join(dataDir, "setup.token");
const setupDone = (db: Db): boolean => getInstance(db, "setup") === "done";

/** Until the first person exists, setup is protected by a one-time token only someone with access to the data directory can read. */
export function ensureSetupToken(db: Db, dataDir: string): void {
  if (!setupDone(db) && !existsSync(tokenPath(dataDir))) writeFileSync(tokenPath(dataDir), `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
}

function assertSetupToken(gov: Gov, given: string): void {
  const path = tokenPath(gov.dataDir);
  if (setupDone(gov.db) || !existsSync(path)) throw new BrainError("CONFLICT", "This Brain is already set up");
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 512) throw new BrainError("FORBIDDEN", "The setup token file must be a file only its owner can read");
  const digest = (token: string): Buffer => Buffer.from(hmacSha256Hex(gov.keys.digests, Buffer.from(token)), "hex");
  if (!timingSafeEqual(digest(readFileSync(path, "utf8").trim()), digest(given.trim()))) throw new BrainError("FORBIDDEN", "The setup token is wrong");
}

const admins = (db: Db, workspaceId: string): number => (db.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id=? AND role='admin'").get(workspaceId) as { n: number }).n;
const roleOf = (db: Db, workspaceId: string, userId: string): Role | undefined =>
  (db.prepare("SELECT role FROM members WHERE workspace_id=? AND user_id=?").get(workspaceId, userId) as { role: Role } | undefined)?.role;

export function registerAuth({ gov: { registry } }: Governor): void {
  registry.query("setup.status", (ctx) => ({ setupRequired: !setupDone(ctx.db) }));

  const settingUp = new WeakSet<Gov>();
  registry.command<"setup.create", { userId: string; cookies: string[]; starter?: { input: CommandInput<"workspace.create">; folder: NewWorkspace } }>("setup.create", {
    async prepare(ctx, input) {
      assertSetupToken(ctx.gov, input.token);
      if (settingUp.has(ctx.gov)) throw new BrainError("CONFLICT", "Setup is already in progress");
      settingUp.add(ctx.gov);
      try {
        // An account left by a setup that stopped half-way must prove its password instead of being made again.
        if (!ctx.gov.auth.find(input.email)) await ctx.gov.auth.createAccount({ email: input.email, name: input.name, password: input.password });
        const signedIn = await ctx.gov.auth.signIn(input.email, input.password);
        // The first screen is never empty: a workspace made from the base pack, when the packs directory has one.
        const starter = starterWorkspace(ctx.gov);
        return starter ? { ...signedIn, starter: { input: starter, folder: await commitNewWorkspace(ctx.gov, starter, { name: input.name, email: input.email }) } } : signedIn;
      } finally {
        settingUp.delete(ctx.gov);
      }
    },
    run(ctx, _input, { userId, cookies, starter }) {
      if (setupDone(ctx.db)) throw new BrainError("CONFLICT", "This Brain is already set up");
      ctx.db.prepare("INSERT INTO instance_admins(user_id, created_at_ms) VALUES (?,?)").run(userId, ctx.now());
      setInstance(ctx.db, "setup", "done");
      append(ctx.db, { type: "setup.completed", subject: `user:${userId}`, payload: { userId }, actor: { kind: "person", id: userId } });
      if (starter) createWorkspace(ctx.gov, ctx.db, starter.input, starter.folder, userId);
      rmSync(tokenPath(ctx.gov.dataDir), { force: true });
      ctx.cookies.push(...cookies);
      return { userId };
    },
  });

  registry.query("me", (ctx) => {
    if (!ctx.user) return { user: null, workspaces: [] };
    return { user: ctx.user, workspaces: visibleWorkspaces(ctx.gov, ctx.user.id) };
  });

  registry.command<"member.set", { userId: string; created: boolean }>("member.set", {
    async prepare(ctx, input) {
      const known = ctx.gov.auth.find(input.email);
      if (known) return { userId: known.id, created: false };
      if (!input.name || !input.password) {
        throw new BrainError("INVALID_INPUT", `${input.email} has no account yet: give a name and a first password`, [
          ...(input.name ? [] : [{ path: "name", message: "needed for a new account" }]), ...(input.password ? [] : [{ path: "password", message: "needed for a new account" }]),
        ]);
      }
      return { userId: await ctx.gov.auth.createAccount({ email: input.email, name: input.name, password: input.password }), created: true };
    },
    run(ctx, input, { userId, created }) {
      if (roleOf(ctx.db, input.workspaceId, userId) === "admin" && input.role !== "admin" && admins(ctx.db, input.workspaceId) === 1) throw new BrainError("CONFLICT", "A workspace keeps at least one admin");
      ctx.db.prepare(`INSERT INTO members(workspace_id, user_id, role, created_at_ms) VALUES (?,?,?,?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET role=excluded.role`).run(input.workspaceId, userId, input.role, ctx.now());
      append(ctx.db, { type: "member.set", workspaceId: input.workspaceId, subject: `user:${userId}`, payload: { userId, role: input.role, created }, actor: ctx.actor });
      return { userId, created };
    },
  });

  registry.command("member.remove", (ctx, input) => {
    const role = roleOf(ctx.db, input.workspaceId, input.userId);
    if (!role) throw new BrainError("NOT_FOUND", "This person is not a member of the workspace");
    if (role === "admin" && admins(ctx.db, input.workspaceId) === 1) throw new BrainError("CONFLICT", "A workspace keeps at least one admin");
    ctx.db.prepare("DELETE FROM members WHERE workspace_id=? AND user_id=?").run(input.workspaceId, input.userId);
    append(ctx.db, { type: "member.removed", workspaceId: input.workspaceId, subject: `user:${input.userId}`, payload: { userId: input.userId }, actor: ctx.actor });
    return {};
  });

  registry.query("members.list", (ctx, input) => ({
    members: (ctx.db.prepare(`SELECT m.user_id AS userId, u.name, u.email, m.role, d.user_id IS NULL AS active FROM members m JOIN "user" u ON u.id = m.user_id LEFT JOIN deactivated_users d ON d.user_id = m.user_id WHERE m.workspace_id=? ORDER BY u.name`).all(input.workspaceId) as Array<{ userId: string; name: string; email: string; role: Role; active: number }>).map((row) => ({ ...row, active: row.active === 1 })),
    // The groups with a role here, and the people who have it through them.
    groups: (ctx.db.prepare("SELECT g.id AS groupId, g.name, gg.role FROM group_grants gg JOIN groups g ON g.id = gg.group_id WHERE gg.workspace_id=? ORDER BY g.name COLLATE NOCASE").all(input.workspaceId) as Array<{ groupId: string; name: string; role: Role }>).map((group) => ({
      ...group, members: ctx.db.prepare(`SELECT u.id AS userId, u.name, u.email FROM group_members gm JOIN "user" u ON u.id = gm.user_id WHERE gm.group_id=? ORDER BY u.name`).all(group.groupId) as Array<{ userId: string; name: string; email: string }>,
    })),
  }));
}
