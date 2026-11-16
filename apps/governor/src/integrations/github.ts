import { BrainError, secretName, type JsonValue } from "@brain/contracts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Governor } from "../app";
import { tx } from "../db";
import { SYSTEM } from "../events";
import { settle } from "../tasks/orchestrator";
import { createFromPlay } from "../tasks/store";
import { readSecret } from "../trust/secrets";
import { manifestOf } from "../workspace/store";

/** GitHub webhooks (docs/architecture.md section 9): a signed delivery about a project's repository starts the Plays whose trigger names its event. */
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024;

/** `owner/name` of a repository address, lower-case: what GitHub calls its full name. */
export const repoPath = (repo: string): string => repo.replace(/^[a-z+]+:\/\/[^/]+\//iu, "").replace(/^[^@/]+@[^:/]+:/u, "").replace(/\.git$/u, "").replace(/^\/+|\/+$/gu, "").toLowerCase();

const same = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function registerGithub({ gov, app }: Governor): void {
  const { db } = gov;
  app.post("/hooks/github/:workspace", async (c) => {
    const raw = Buffer.from(await c.req.raw.arrayBuffer());
    const workspace = db.prepare("SELECT id, active_snapshot AS digest FROM workspaces WHERE (slug=? OR id=?) AND status='active'").get(c.req.param("workspace"), c.req.param("workspace")) as { id: string; digest: string } | undefined;
    const manifest = workspace ? manifestOf(gov, workspace.digest) : undefined;
    const secret = workspace && manifest?.github?.webhook_secret ? readSecret(gov, workspace.id, secretName(manifest.github.webhook_secret)) : undefined;
    // An unknown workspace, a workspace with no secret and a wrong signature cost the same and are told the same.
    const signed = same(c.req.header("x-hub-signature-256") ?? "", `sha256=${createHmac("sha256", secret ?? "no-secret").update(raw).digest("hex")}`);
    if (!workspace || !manifest || secret === undefined || !signed) throw new BrainError("UNAUTHENTICATED", "The delivery is not signed with this workspace's webhook secret");
    const deliveryId = c.req.header("x-github-delivery");
    const event = c.req.header("x-github-event");
    if (raw.length > MAX_DELIVERY_BYTES || !deliveryId || !event || !/^[a-z_]+$/u.test(event)) throw new BrainError("INVALID_INPUT", "The delivery is too large or names no event");
    let delivery: { readonly [key: string]: JsonValue };
    try { delivery = JSON.parse(raw.toString("utf8")) as { readonly [key: string]: JsonValue }; } catch { throw new BrainError("INVALID_INPUT", "The delivery is not JSON"); }
    const action = typeof delivery["action"] === "string" ? delivery["action"] : undefined;
    const repository = (delivery["repository"] as { full_name?: unknown } | undefined)?.full_name;
    const started = tx(db, () => {
      // A delivery GitHub sends again starts nothing again.
      const first = db.prepare("INSERT OR IGNORE INTO webhook_deliveries(workspace_id, delivery_id, event, payload_digest, received_at_ms) VALUES (?,?,?,?,?)")
        .run(workspace.id, deliveryId, action ? `${event}.${action}` : event, `sha256:${createHash("sha256").update(raw).digest("hex")}`, gov.clock.nowMs()).changes > 0;
      if (!first || typeof repository !== "string" || !manifest.projects.some((project) => repoPath(project.repo) === repository.toLowerCase())) return [];
      const plays = db.prepare("SELECT play FROM triggers WHERE workspace_id=? AND kind='webhook' AND spec IN (?, ?) ORDER BY play").all(workspace.id, `github.${event}`, `github.${event}.${action ?? ""}`) as Array<{ play: string }>;
      const ids = plays.map(({ play }) => createFromPlay(gov, SYSTEM, { workspaceId: workspace.id, snapshotDigest: workspace.digest, play, inputs: { delivery }, createdBy: `trigger:${play}` }).id);
      settle(gov, workspace.id);
      return ids;
    });
    return c.json({ started });
  });
}
