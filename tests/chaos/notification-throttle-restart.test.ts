import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { notifyAttention } from "../../apps/governor/src/modules/operations/index";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Plan ${id}`, criteria: [`${id}-done`], dependsOn: [] });
const finish = async (w: World, missionId: string, planTaskId: string) => {
  const item = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === missionId && entry.planTaskId === planTaskId)!;
  w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=?, updated_at_ms=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, w.brain.store.now(), item.workItemId);
};

describe("notification throttle across a Governor restart (row 54)", () => {
  it("the 15-minute per-mission window and the once-per-item record survive a restart, and the window still ends", async () => {
    const w = setupWorld();
    let reopened: Brain | undefined;
    try {
      const id = (await run(w, "mission.create", "t-create", { title: "Launch", intent: "Deliver the launch", successCriteria: ["delivered"] })).resourceId ?? "";
      const planId = (await run(w, "plan.propose", "t-plan", { missionId: id, origin: "manual", tasks: [task("a"), task("b")] })).resourceId ?? "";
      const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot.version;
      await run(w, "plan.confirm", "t-confirm", { planVersionId: planId }, version);

      await finish(w, id, "a");
      expect(notifyAttention(w.brain.store, undefined)).toBe(1);
      await finish(w, id, "b");
      // Inside the window: held back, not lost.
      expect(notifyAttention(w.brain.store, undefined)).toBe(0);
      w.brain.close();

      reopened = new Brain({ dataDir: w.dir, allowTestActor: true });
      // The restart neither forgets the window (a duplicate would go out) nor repeats the first item.
      expect(notifyAttention(reopened.store, undefined)).toBe(0);
      const db = reopened.store.workspaceDb(w.workspaceId, w.org);
      expect((db.prepare("SELECT COUNT(*) AS n FROM attention_notifications").get() as { n: number }).n).toBe(1);
      // Once the window is over the held item goes out exactly once, and the first one is never repeated.
      db.prepare("UPDATE attention_notifications SET sent_at_ms=sent_at_ms-?").run(16 * 60_000);
      expect(notifyAttention(reopened.store, undefined)).toBe(1);
      expect(notifyAttention(reopened.store, undefined)).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM attention_notifications").get() as { n: number }).n).toBe(2);
      const actor: ActorContext = { ...w.owner, scopes: scopesForPrincipal(reopened.store, "owner-1", w.org, w.workspaceId) };
      const inbox = ((await reopened.executeQuery(actor, { queryType: "notifications.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: unknown[] } }).snapshot.items;
      expect(inbox).toHaveLength(2);
    } finally {
      reopened?.close();
    }
  });
});
