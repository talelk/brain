import { describe, expect, it } from "vitest";
import type { ActorContext, CapabilityCandidate, KnowledgeAsset } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { setupWorld } from "../helpers";
import { captureOperation } from "../support/capitalization";

describe("capitalization restart recovery (E110)", () => {
  it("resumes queued and interrupted runs without duplicate assets, candidates or events", () => {
    const world = setupWorld();
    let reopened: Brain | undefined;
    try {
      for (const root of ["root-restart-1", "root-restart-2", "root-restart-3"]) captureOperation(world, root);
      const db = world.brain.store.workspaceDb(world.workspaceId, world.org);
      const first = db.prepare("SELECT id FROM capitalization_runs ORDER BY created_at_ms,id LIMIT 1").get() as { id: string };
      db.prepare("UPDATE capitalization_runs SET state='running',started_at_ms=? WHERE id=?").run(world.brain.store.now(), first.id);
      world.brain.close();

      reopened = new Brain({ dataDir: world.dir, allowTestActor: true });
      expect(reopened.runCapitalization()).toEqual({ processed: 3, failed: 0 });
      expect(reopened.runCapitalization()).toEqual({ processed: 0, failed: 0 });
      const actor: ActorContext = { ...world.owner, scopes: scopesForPrincipal(reopened.store, world.owner.actorId, world.org, world.workspaceId) };
      const assets = (reopened.executeQuery(actor, { queryType: "knowledgeAssets.list", workspaceId: world.workspaceId }) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
      const candidates = (reopened.executeQuery(actor, { queryType: "capabilityCandidates.list", workspaceId: world.workspaceId }) as unknown as { snapshot: { items: CapabilityCandidate[] } }).snapshot.items;
      expect(assets).toHaveLength(1);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.state).toBe("quarantined");
      const recovered = reopened.store.workspaceDb(world.workspaceId, world.org);
      expect((recovered.prepare("SELECT COUNT(*) AS count FROM capitalization_runs WHERE state='succeeded'").get() as { count: number }).count).toBe(3);
      expect((recovered.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='capitalization.completed'").get() as { count: number }).count).toBe(3);
      expect((recovered.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='knowledge.extracted'").get() as { count: number }).count).toBe(1);
    } finally {
      reopened?.close();
    }
  });
});
