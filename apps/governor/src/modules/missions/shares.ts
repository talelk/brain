import { randomBytes } from "node:crypto";
import type { ActorContext } from "@brain/contracts";
import type { Store } from "../../application/store";
import { hasWorkspaceMembership, requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { readVerified } from "../artifacts/index";

/**
 * Read-only share links for one result (issue #60, ADR 0013). A link names exactly one verified, final output version, is
 * owner-created, expires (7 days by default, 30 at most), can be revoked, and shows the readable text of that version and
 * nothing else: no mission, plan, team, run or workspace data, and no way to act. The bearer token is 32 random bytes shown
 * once; only its keyed digest is stored (control.db, so the public route can find the workspace without a session).
 */
export const SHARE_DEFAULT_HOURS = 168;
export const SHARE_MAX_HOURS = 720;
/** Largest text a shared page returns; the rest is cut and said so. */
const SHARE_TEXT_BYTES = 1_000_000;
/** Only text a person can read in a page is shared. */
const SHAREABLE_MEDIA = /^(text\/(plain|markdown|csv)|application\/json)(;|$)/u;
/** One view event per share per minute; the counter still counts every view. */
const VIEW_EVENT_INTERVAL_MS = 60_000;
const MAX_ACTIVE_PER_VERSION = 10;

type Db = ReturnType<Store["workspaceDb"]>;
interface ShareRow {
  id: string; organization_id: string; workspace_id: string; version_id: string; mission_id: string; token_digest: string; created_by: string;
  expires_at_ms: number; revoked_at_ms: number | null; revoked_by: string | null; views: number; last_viewed_at_ms: number | null; created_at_ms: number;
}

export interface ShareView {
  readonly shareId: string; readonly versionId: string; readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
  readonly state: "active" | "expired" | "revoked"; readonly views: number; readonly lastViewedAt?: string; readonly revokedAt?: string;
}

export interface SharedResult {
  readonly name: string; readonly versionLabel: string; readonly verified: true; readonly recordedAt: string; readonly sharedAt: string; readonly expiresAt: string;
  readonly mediaType: string; readonly text: string; readonly truncated: boolean;
}

export type SharedLookup = { readonly kind: "ok"; readonly result: SharedResult } | { readonly kind: "gone"; readonly reason: "expired" | "revoked" } | { readonly kind: "missing" };

const stateOf = (row: ShareRow, now: number): ShareView["state"] => row.revoked_at_ms !== null ? "revoked" : row.expires_at_ms <= now ? "expired" : "active";
const viewOf = (row: ShareRow, now: number): ShareView => ({
  shareId: row.id, versionId: row.version_id, createdBy: row.created_by, createdAt: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms), state: stateOf(row, now), views: row.views,
  ...(row.last_viewed_at_ms !== null ? { lastViewedAt: iso(row.last_viewed_at_ms) } : {}), ...(row.revoked_at_ms !== null ? { revokedAt: iso(row.revoked_at_ms) } : {}),
});

function requireSharer(actor: ActorContext): void {
  if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person can share a result");
  if (!actor.scopes.includes("mission:write")) throw new BrainDomainError("FORBIDDEN", "sharing a result requires mission:write");
}

/** The artifact bytes a version points at, when the version is shareable at all. */
function shareable(db: Db, versionId: string): { name: string; label: string; digest: string; bytes: number; mediaType: string; recordedAtMs: number; missionId: string } {
  const version = db.prepare("SELECT v.id, v.artifact_digest, v.state, v.verified, v.created_at_ms, o.name, o.id AS output_id, o.mission_id FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE v.id=?").get(versionId) as
    | { id: string; artifact_digest: string; state: string; verified: number; created_at_ms: number; name: string; output_id: string; mission_id: string } | undefined;
  if (!version) throw new BrainDomainError("NOT_FOUND", "result version not found");
  if (version.state !== "final" || version.verified !== 1) throw new BrainDomainError("CONFLICT", "only a verified, final result can be shared");
  const artifact = db.prepare("SELECT digest, bytes, media_type, classification FROM artifacts WHERE digest=? AND state<>'deleted' AND id NOT IN (SELECT id FROM document_versions) ORDER BY created_at_ms DESC LIMIT 1").get(version.artifact_digest) as
    | { digest: string; bytes: number; media_type: string; classification: string } | undefined;
  if (!artifact) throw new BrainDomainError("NOT_FOUND", "the result's file is not available");
  if (artifact.classification === "confidential" || artifact.classification === "restricted") throw new BrainDomainError("POLICY_DENIED", `a ${artifact.classification} result cannot be shared outside the workspace`);
  if (!SHAREABLE_MEDIA.test(artifact.media_type)) throw new BrainDomainError("INVALID_ARGUMENT", "only readable text results can be shared");
  const ordinal = (db.prepare("SELECT COUNT(*) AS n FROM output_versions WHERE output_id=? AND (created_at_ms<? OR (created_at_ms=? AND id<=?))").get(version.output_id, version.created_at_ms, version.created_at_ms, version.id) as { n: number }).n;
  return { name: version.name, label: `Version ${ordinal}`, digest: artifact.digest, bytes: artifact.bytes, mediaType: artifact.media_type, recordedAtMs: version.created_at_ms, missionId: version.mission_id };
}

export class ShareService {
  constructor(private readonly store: Store) {}

  /** Creates a link. The token is returned here and never again. */
  create(actor: ActorContext, workspaceId: string, input: { versionId: string; expiresInHours?: number }): { shareId: string; token: string; expiresAt: string } {
    requireSharer(actor);
    requireWorkspaceRead(this.store, actor, workspaceId);
    const hours = input.expiresInHours ?? SHARE_DEFAULT_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > SHARE_MAX_HOURS) throw new BrainDomainError("INVALID_ARGUMENT", `a link lasts between 1 hour and ${SHARE_MAX_HOURS / 24} days`);
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    const target = shareable(db, input.versionId);
    const now = this.store.now();
    const active = (this.store.control.prepare("SELECT COUNT(*) AS n FROM result_shares WHERE organization_id=? AND workspace_id=? AND version_id=? AND revoked_at_ms IS NULL AND expires_at_ms>?").get(actor.organizationId, workspaceId, input.versionId, now) as { n: number }).n;
    if (active >= MAX_ACTIVE_PER_VERSION) throw new BrainDomainError("CAPACITY_EXCEEDED", "this result already has the most links it can have; revoke one first");
    const token = randomBytes(32).toString("base64url");
    const id = this.store.id("share");
    const expiresAt = now + hours * 3_600_000;
    this.store.control.prepare("INSERT INTO result_shares(id,organization_id,workspace_id,version_id,mission_id,token_digest,created_by,expires_at_ms,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, actor.organizationId, workspaceId, input.versionId, target.missionId, this.store.tokenDigest("result-share", token), actor.actorId, expiresAt, now);
    this.store.emit(db, { workspaceId, aggregateType: "share", aggregateId: id, eventType: "share.created", payload: { shareId: id, versionId: input.versionId, expiresAt: iso(expiresAt), createdBy: actor.actorId } });
    return { shareId: id, token, expiresAt: iso(expiresAt) };
  }

  /** The links of one workspace (all of them for a workspace admin, otherwise the caller's own), never with a token. */
  list(actor: ActorContext, workspaceId: string, versionId?: string): ShareView[] {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const all = actor.scopes.includes("workspace:admin");
    const rows = this.store.control.prepare(`SELECT * FROM result_shares WHERE organization_id=? AND workspace_id=? ${versionId ? "AND version_id=?" : ""} ${all ? "" : "AND created_by=?"} ORDER BY created_at_ms DESC, id LIMIT 100`)
      .all(...[actor.organizationId, workspaceId, ...(versionId ? [versionId] : []), ...(all ? [] : [actor.actorId])]) as ShareRow[];
    const now = this.store.now();
    return rows.map((row) => viewOf(row, now));
  }

  /** Revokes a link at once. Its creator or a workspace admin may; revoking twice is a no-op. */
  revoke(actor: ActorContext, workspaceId: string, shareId: string): ShareView {
    requireSharer(actor);
    requireWorkspaceRead(this.store, actor, workspaceId);
    const row = this.store.control.prepare("SELECT * FROM result_shares WHERE id=? AND organization_id=? AND workspace_id=?").get(shareId, actor.organizationId, workspaceId) as ShareRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "share link not found");
    if (row.created_by !== actor.actorId && !actor.scopes.includes("workspace:admin")) throw new BrainDomainError("FORBIDDEN", "only the person who created a link, or a workspace admin, can revoke it");
    if (row.revoked_at_ms === null) {
      const now = this.store.now();
      this.store.control.prepare("UPDATE result_shares SET revoked_at_ms=?, revoked_by=? WHERE id=? AND revoked_at_ms IS NULL").run(now, actor.actorId, shareId);
      this.store.emit(this.store.workspaceDb(workspaceId, actor.organizationId), { workspaceId, aggregateType: "share", aggregateId: shareId, eventType: "share.revoked", payload: { shareId, revokedBy: actor.actorId } });
    }
    return viewOf(this.store.control.prepare("SELECT * FROM result_shares WHERE id=?").get(shareId) as ShareRow, this.store.now());
  }

  /**
   * The public read: the token alone proves access, to this one version and nothing else. Every check is made now, not
   * at creation: not revoked, not expired, the workspace still active, the creator still a member with the sharing scope.
   */
  view(token: string): SharedLookup {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return { kind: "missing" };
    const row = this.store.control.prepare("SELECT * FROM result_shares WHERE token_digest=?").get(this.store.tokenDigest("result-share", token)) as ShareRow | undefined;
    if (!row) return { kind: "missing" };
    const now = this.store.now();
    if (row.revoked_at_ms !== null) return { kind: "gone", reason: "revoked" };
    if (row.expires_at_ms <= now) return { kind: "gone", reason: "expired" };
    const workspace = this.store.control.prepare("SELECT status FROM workspaces WHERE id=? AND organization_id=?").get(row.workspace_id, row.organization_id) as { status: string } | undefined;
    if (!workspace || workspace.status !== "active") return { kind: "gone", reason: "revoked" };
    // A link outlives nobody's access: when its creator loses the workspace, the link stops working.
    if (!hasWorkspaceMembership(this.store, row.created_by, row.organization_id, row.workspace_id)) return { kind: "gone", reason: "revoked" };
    const db = this.store.workspaceDb(row.workspace_id, row.organization_id);
    let target: ReturnType<typeof shareable>;
    try { target = shareable(db, row.version_id); } catch { return { kind: "gone", reason: "revoked" }; }
    const bytes = readVerified(this.store, target.digest, target.bytes);
    const clipped = bytes.length > SHARE_TEXT_BYTES;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(clipped ? bytes.subarray(0, SHARE_TEXT_BYTES) : bytes);
    this.store.control.prepare("UPDATE result_shares SET views=views+1, last_viewed_at_ms=? WHERE id=?").run(now, row.id);
    if (row.last_viewed_at_ms === null || now - row.last_viewed_at_ms >= VIEW_EVENT_INTERVAL_MS) {
      this.store.emit(db, { workspaceId: row.workspace_id, aggregateType: "share", aggregateId: row.id, eventType: "share.viewed", payload: { shareId: row.id, views: row.views + 1 } });
    }
    return { kind: "ok", result: { name: target.name, versionLabel: target.label, verified: true, recordedAt: iso(target.recordedAtMs), sharedAt: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms), mediaType: target.mediaType, text, truncated: clipped } };
  }
}
