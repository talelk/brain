import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "@brain/contracts";
import { Store } from "../../apps/governor/src/application/store";
import { AutomationService, type AutomationDispatchDeps } from "../../apps/governor/src/modules/jobs/automation";

describe("automation restart recovery (T52, E104)", () => {
  it("keeps occurrence identity and history across Governor restart and replay", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const dir = mkdtempSync(join(tmpdir(), "brain-automation-restart-"));
    let store = new Store({ dataDir: dir, allowTestActor: true, clock: clock as never });
    const starts: Array<{ executionKey: string; runInput: unknown }> = [];
    const deps: AutomationDispatchDeps = {
      resolveWorkflow: (_organizationId, workflowId) => ({ workflow: { id: workflowId }, configDigest: `sha256:${"1".repeat(64)}` }),
      startRun: (input) => {
        starts.push({ executionKey: input.executionKey, runInput: input.runInput });
        return { runId: `run-auto-${starts.length}` };
      },
    };
    try {
      store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-auto-restart', 'auth-auto-restart')").run();
      store.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES ('ws-auto-restart', 'org-auto-restart', 'auto-restart', 'active')").run();
      store.control.prepare("INSERT INTO principals(id, organization_id, kind, auth_subject_id) VALUES ('operator-restart', 'org-auto-restart', 'human', 'auto-restart-operator')").run();
      store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-auto-restart','org-auto-restart','operator-restart','workspace-lead',1,'operator-restart',?)").run(now);
      const actor: ActorContext = { kind: "human", actorId: "operator-restart", organizationId: "org-auto-restart", workspaceId: "ws-auto-restart", scopes: ["workspace:read", "workflow:dispatch"], authMethod: "session", authGeneration: 1 };
      let service = new AutomationService(store, deps);
      const id = service.apply(actor, {
        commandType: "automation.upsert", workspaceId: "ws-auto-restart",
        payload: { title: "Restart safe", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, input: { situation: "scheduled" }, misfire: "coalesce" },
      });
      now += 90_000;
      expect(service.dispatchAll().dispatched).toBe(1);
      expect(starts).toHaveLength(1);

      store.close();
      store = new Store({ dataDir: dir, allowTestActor: true, clock: clock as never });
      service = new AutomationService(store, deps);
      expect(service.dispatchAll().dispatched).toBe(0);
      expect(starts).toHaveLength(1);
      let history = service.query(actor, "automations.occurrences", "ws-auto-restart", id) as { items: Array<{ state: string; dispatchRef: string }> };
      expect(history.items).toHaveLength(1);
      expect(history.items[0]).toMatchObject({ state: "dispatched", dispatchRef: "run-auto-1" });

      now += 60_000;
      expect(service.dispatchAll().dispatched).toBe(1);
      expect(service.dispatchAll().dispatched).toBe(0);
      expect(starts).toHaveLength(2);
      expect(new Set(starts.map((start) => start.executionKey)).size).toBe(2);
      expect(starts.every((start) => JSON.stringify(start.runInput) === JSON.stringify({ situation: "scheduled" }))).toBe(true);
      history = service.query(actor, "automations.occurrences", "ws-auto-restart", id) as { items: Array<{ state: string; dispatchRef: string }> };
      expect(history.items).toHaveLength(2);
      expect(history.items.every((occurrence) => occurrence.state === "dispatched")).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
