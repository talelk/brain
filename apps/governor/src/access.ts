import type { PlatformKind, Role, WorkspaceSummary } from "@brain/contracts";
import type { Gov } from "./dispatch";
import { manifestOf } from "./workspace/store";

/**
 * Who may see a workspace and as what (docs/architecture.md section 4). Every place that asks "is this person in this workspace" asks here:
 * a member has their role; any other signed-in person is a `viewer` of an active workspace whose active snapshot says `visibility = "public"`;
 * everyone else is told the workspace does not exist. A snapshot made before visibility existed reads as private.
 */
export interface Access { readonly role: Role; readonly status: "active" | "archived"; readonly viaPublic: boolean }

interface Row { readonly id: string; readonly slug: string; readonly name: string; readonly description: string; readonly status: "active" | "archived"; readonly snapshot: string; readonly role: Role | null }
const isPublic = (gov: Gov, row: Row): boolean => row.status === "active" && (manifestOf(gov, row.snapshot) as { visibility?: string }).visibility === "public";
/** The role is the highest of the person's own and the roles their groups give (docs/model.md, Users, invitations and groups); `@user` is the person. */
const SELECT = `SELECT w.id, w.slug, w.name, w.description, w.status, w.active_snapshot AS snapshot, (
  SELECT role FROM (
    SELECT role FROM members WHERE workspace_id = w.id AND user_id = @user
    UNION ALL SELECT g.role FROM group_grants g JOIN group_members gm ON gm.group_id = g.group_id WHERE g.workspace_id = w.id AND gm.user_id = @user
  ) ORDER BY CASE role WHEN 'admin' THEN 3 WHEN 'member' THEN 2 ELSE 1 END DESC LIMIT 1) AS role FROM workspaces w`;

const isInstanceAdmin = (gov: Gov, userId: string): boolean => gov.db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(userId) !== undefined;
const platformOfRow = (gov: Gov, row: Row): PlatformKind | null => (row.snapshot === "" ? null : (manifestOf(gov, row.snapshot as never).platform ?? null));

export function accessOf(gov: Gov, userId: string, workspaceId: string): Access | undefined {
  const row = gov.db.prepare(`${SELECT} WHERE w.id = @workspace`).get({ user: userId, workspace: workspaceId }) as Row | undefined;
  if (!row) return undefined;
  // A platform workspace holds what every workspace did: it exists only for instance admins, members or not (docs/model.md).
  if (platformOfRow(gov, row) !== null && !isInstanceAdmin(gov, userId)) return undefined;
  if (row.role) return { role: row.role, status: row.status, viaPublic: false };
  return isPublic(gov, row) ? { role: "viewer", status: "active", viaPublic: true } : undefined;
}

/** The workspaces a person sees: those they are a member of, and the public active ones. */
export function visibleWorkspaces(gov: Gov, userId: string): WorkspaceSummary[] {
  const rows = gov.db.prepare(`${SELECT} ORDER BY w.status, w.name, w.id`).all({ user: userId }) as Row[];
  const admin = isInstanceAdmin(gov, userId);
  return rows.flatMap((row): WorkspaceSummary[] => {
    const platform = platformOfRow(gov, row);
    if (platform && !admin) return [];
    const open = isPublic(gov, row);
    if (!row.role && !open) return [];
    const { id, slug, name, description, status } = row;
    return [{ id, slug, name, description, status, role: row.role ?? "viewer", visibility: open ? "public" : "private", platform, viaPublic: !row.role }];
  });
}
