import { randomBytes } from "node:crypto";
import type { ActorContext, JsonValue, WebhookKind } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { decryptWebhookSecret, encryptWebhookSecret } from "./webhook-signature";

const KINDS: readonly WebhookKind[] = ["github", "gitlab", "ticket"];
type EndpointRow = { id: string; organization_id: string; workspace_id: string; kind: WebhookKind; connection_id: string | null; encrypted_secret: string; created_at_ms: number; rotated_at_ms: number | null };
type DeliveryRow = { event: string; status: "applied" | "ignored"; detail: string; received_at_ms: number };

export const webhookPath = (kind: WebhookKind, endpointId: string): string => `/hooks/${kind}/${endpointId}`;

function secretOf(value: unknown): string {
  const secret = typeof value === "string" ? value : "";
  if (secret.length < 16 || secret.length > 256) throw new BrainDomainError("INVALID_ARGUMENT", "the webhook secret must be 16 to 256 characters");
  return secret;
}

/**
 * The signed webhook endpoints of an organization (ADR 0077): where each one is, which workspace it feeds, and its secret, which is stored
 * encrypted, replaced by rotation and never read back. The per-delivery work lives in the application layer; this holds what an administrator manages.
 */
export class WebhookEndpoints {
  constructor(private readonly store: Store) {}

  create(actor: ActorContext, payload: Readonly<Record<string, unknown>>): string {
    const kind = String(payload["kind"]) as WebhookKind;
    if (!KINDS.includes(kind)) throw new BrainDomainError("INVALID_ARGUMENT", "webhook kind must be github, gitlab or ticket");
    const workspaceId = String(payload["workspaceId"] ?? "");
    if (!this.store.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, actor.organizationId)) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    const connectionId = payload["connectionId"] === undefined || payload["connectionId"] === "" ? undefined : String(payload["connectionId"]);
    if (connectionId) {
      const connection = this.store.control.prepare("SELECT provider FROM git_connections WHERE id=? AND organization_id=?").get(connectionId, actor.organizationId) as { provider: string } | undefined;
      if (!connection) throw new BrainDomainError("NOT_FOUND", "Git connection not found");
      const fits = kind === "github" ? connection.provider === "github" || connection.provider === "github-enterprise" : kind === "gitlab" ? connection.provider === "gitlab" : false;
      if (!fits) throw new BrainDomainError("INVALID_ARGUMENT", `a ${kind} webhook cannot belong to a ${connection.provider} connection`);
    }
    const secret = secretOf(payload["secret"]);
    const id = `whk-${randomBytes(15).toString("base64url")}`;
    this.store.control.prepare("INSERT INTO webhook_endpoints(id,organization_id,workspace_id,kind,connection_id,encrypted_secret,created_by,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, actor.organizationId, workspaceId, kind, connectionId ?? null, encryptWebhookSecret(this.store.pepper, actor.organizationId, id, secret), actor.actorId, this.store.now());
    return id;
  }

  rotate(actor: ActorContext, payload: Readonly<Record<string, unknown>>): string {
    const id = String(payload["endpointId"] ?? "");
    const row = this.store.control.prepare("SELECT organization_id FROM webhook_endpoints WHERE id=? AND organization_id=?").get(id, actor.organizationId);
    if (!row) throw new BrainDomainError("NOT_FOUND", "webhook endpoint not found");
    const secret = secretOf(payload["secret"]);
    this.store.control.prepare("UPDATE webhook_endpoints SET encrypted_secret=?, rotated_at_ms=?, rotated_by=? WHERE id=?")
      .run(encryptWebhookSecret(this.store.pepper, actor.organizationId, id, secret), this.store.now(), actor.actorId, id);
    return id;
  }

  /** What a delivery needs to be checked: the workspace it feeds and the secret. Undefined for an id nobody created. */
  resolve(endpointId: string): { id: string; organizationId: string; workspaceId: string; kind: WebhookKind; connectionId: string | undefined; secret: string } | undefined {
    const row = this.store.control.prepare("SELECT * FROM webhook_endpoints WHERE id=?").get(endpointId) as EndpointRow | undefined;
    if (!row) return undefined;
    return { id: row.id, organizationId: row.organization_id, workspaceId: row.workspace_id, kind: row.kind, connectionId: row.connection_id ?? undefined, secret: decryptWebhookSecret(this.store.pepper, row.organization_id, row.id, row.encrypted_secret) };
  }

  /** Administration > Integrations: each endpoint with its address and its last deliveries, status only (no body, no secret). */
  list(actor: ActorContext): JsonValue {
    if (!actor.scopes.includes("platform:read")) throw new BrainDomainError("FORBIDDEN", "integration administration requires platform:read");
    const rows = this.store.control.prepare("SELECT e.*, w.slug AS workspace_name FROM webhook_endpoints e JOIN workspaces w ON w.id=e.workspace_id WHERE e.organization_id=? ORDER BY e.created_at_ms DESC, e.id LIMIT 100").all(actor.organizationId) as Array<EndpointRow & { workspace_name: string }>;
    const endpoints = rows.map((row) => {
      const deliveries = (this.store.workspaceDb(row.workspace_id, row.organization_id).prepare("SELECT event, status, detail, received_at_ms FROM webhook_deliveries WHERE endpoint_id=? ORDER BY received_at_ms DESC, rowid DESC LIMIT 5").all(row.id) as DeliveryRow[])
        .map((delivery) => ({ event: delivery.event, status: delivery.status, ...(delivery.detail ? { detail: delivery.detail } : {}), receivedAt: iso(delivery.received_at_ms) }));
      return {
        endpointId: row.id, kind: row.kind, workspaceId: row.workspace_id, workspaceName: row.workspace_name, ...(row.connection_id ? { connectionId: row.connection_id } : {}),
        path: webhookPath(row.kind, row.id), createdAt: iso(row.created_at_ms), ...(row.rotated_at_ms ? { rotatedAt: iso(row.rotated_at_ms) } : {}), deliveries,
      };
    });
    return { endpoints } as unknown as JsonValue;
  }
}
