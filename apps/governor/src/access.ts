import type { Role, WorkspaceSummary } from "@brain/contracts";
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
const SELECT = `SELECT w.id, w.slug, w.name, w.description, w.status, w.active_snapshot AS snapshot, m.role FROM workspaces w LEFT JOIN members m ON m.workspace_id = w.id AND m.user_id = ?`;

const isInstanceAdmin = (gov: Gov, userId: string): boolean => gov.db.prepare("SELECT 1 FROM instance_admins WHERE user_id=?").get(userId) !== undefined;
const isPlatformRow = (gov: Gov, row: Row): boolean => row.snapshot !== "" && manifestOf(gov, row.snapshot as never).platform === true;

export function accessOf(gov: Gov, userId: string, workspaceId: string): Access | undefined {
  const row = gov.db.prepare(`${SELECT} WHERE w.id = ?`).get(userId, workspaceId) as Row | undefined;
  if (!row) return undefined;
  // The platform workspace holds what every workspace did: it exists only for instance admins, members or not (docs/model.md).
  if (isPlatformRow(gov, row) && !isInstanceAdmin(gov, userId)) return undefined;
  if (row.role) return { role: row.role, status: row.status, viaPublic: false };
  return isPublic(gov, row) ? { role: "viewer", status: "active", viaPublic: true } : undefined;
}

/** The workspaces a person sees: those they are a member of, and the public active ones. */
export function visibleWorkspaces(gov: Gov, userId: string): WorkspaceSummary[] {
  const rows = gov.db.prepare(`${SELECT} ORDER BY w.status, w.name, w.id`).all(userId) as Row[];
  const admin = isInstanceAdmin(gov, userId);
  return rows.flatMap((row): WorkspaceSummary[] => {
    const platform = isPlatformRow(gov, row);
    if (platform && !admin) return [];
    const open = isPublic(gov, row);
    if (!row.role && !open) return [];
    const { id, slug, name, description, status } = row;
    return [{ id, slug, name, description, status, role: row.role ?? "viewer", visibility: open ? "public" : "private", platform, viaPublic: !row.role }];
  });
}
