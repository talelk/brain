import { secretName, type TaskNeed } from "@brain/contracts";
import type { Governor } from "../app";
import { getInstance, setInstance } from "../db";
import type { Gov } from "../dispatch";
import { readEvents } from "../events";
import { ToolRefusal } from "../tools/schema";
import { readSecret } from "../trust/secrets";
import { activeManifest } from "../workspace/store";
import { postEvent } from "./webhook";

/**
 * Teams (docs/architecture.md section 9): a card when a task needs a person and when a goal is done or failed, and the `message.send` tool.
 * The same events go to the workspace's webhook (webhook.ts), from one place in the audit log.
 */

/** Posts one card to the workspace's Teams webhook. Refuses, in plain words, when the workspace has none. */
export async function postTeams(gov: Gov, workspaceId: string, text: string, link?: string): Promise<void> {
  const teams = activeManifest(gov, workspaceId).teams;
  if (!teams) throw new ToolRefusal("This workspace has no Teams channel: brain.toml has no [teams] webhook");
  const url = readSecret(gov, workspaceId, secretName(teams.webhook));
  if (url === undefined) throw new ToolRefusal(`The secret ${secretName(teams.webhook)} that holds the Teams webhook is not set`);
  const card = {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }],
      ...(link ? { actions: [{ type: "Action.OpenUrl", title: "Open in Brain", url: link }] } : {}),
    } }],
  };
  const response = await gov.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card), redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new ToolRefusal(`Teams answered ${response.status}; the message was not posted`);
}

const NEEDS: Record<TaskNeed["kind"], string> = {
  "confirm-plan": "has a plan to confirm", approval: "has a call waiting for approval", answer: "has a question for you", check: "has a result to check", "sign-off": "is waiting for your sign-off",
  judge: "has candidates to choose from", "failed-subtask": "has a sub-task that failed", checkpoint: "reached its checkpoint: continue, change the goal or stop it",
};
const delivering = new WeakMap<Gov, Promise<void>>();

/**
 * Tells the workspace's Teams channel and webhook what happened since the last time: every task that came to need a person, every goal that
 * is done or failed. It reads the audit log from where it stopped, so nothing is lost by a restart or sent twice. What cannot be delivered
 * is dropped.
 */
export function deliverNotifications(gov: Gov): Promise<void> {
  const next = (delivering.get(gov) ?? Promise.resolve()).then(async () => {
    for (const event of readEvents(gov.db, Number(getInstance(gov.db, "cards_through") ?? 0))) {
      setInstance(gov.db, "cards_through", String(event.seq));
      if (!event.workspaceId || !["task.needs_you", "task.done", "task.failed"].includes(event.type)) continue;
      const payload = JSON.parse(event.payloadJson) as { title: string; root: boolean; need?: TaskNeed };
      if (event.type !== "task.needs_you" && !payload.root) continue;
      const row = gov.db.prepare("SELECT status, slug FROM workspaces WHERE id=?").get(event.workspaceId) as { status: string; slug: string } | undefined;
      if (row?.status !== "active") continue;
      const { teams, webhook } = activeManifest(gov, event.workspaceId);
      const taskId = event.subject.slice("task:".length);
      const url = `${gov.baseUrl}/w/${event.workspaceId}/tasks/${taskId}`;
      const text = event.type === "task.needs_you" ? `"${payload.title}" ${payload.need ? NEEDS[payload.need.kind] : "needs you"}.` : `"${payload.title}" ${event.type === "task.done" ? "is done." : "failed."}`;
      await Promise.all([
        teams ? postTeams(gov, event.workspaceId, text, url).catch((e: unknown) => console.error(`Teams card not delivered: ${e instanceof Error ? e.message : String(e)}`)) : undefined,
        webhook ? postEvent(gov, webhook, { id: event.seq, type: event.type, atMs: event.createdAtMs, workspaceId: event.workspaceId, workspaceSlug: row.slug, taskId, data: { title: payload.title, goal: payload.root, ...(payload.need ? { need: payload.need.kind } : {}), url } }) : undefined,
      ]);
    }
  });
  delivering.set(gov, next.catch(() => undefined));
  return next;
}

export function registerTeams(governor: Governor): void {
  governor.every(3_000, () => deliverNotifications(governor.gov));
}
