import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScheduledDispatch } from "../../apps/governor/src/modules/jobs/scheduler";
import { Store } from "../../apps/governor/src/application/store";
import { domainDigest } from "@brain/contracts";

// T19 runtime wiring: declared Schedule documents fire exactly once per due
// minute. The schedule_fires marker (schedule_id, release_digest, minute) is
// the durable dedupe; first sight anchors at now — no historical catch-up.
describe("durable cron dispatch (T19 runtime)", () => {
  function world(clock: { nowMs: () => number }): { store: Store; dir: string; workspaceId: string; org: string } {
    const dir = mkdtempSync(join(tmpdir(), "brain-sched-"));
    const store = new Store({ dataDir: dir, allowTestActor: true, clock: clock as never });
    const org = "org-sched";
    const workspaceId = "ws-sched";
    store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES (?, 'auth-sched')").run(org);
    store.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES (?, ?, 'sched', 'active')").run(workspaceId, org);
    const manifest = JSON.stringify({
      workflows: { "fixture-workflow": { metadata: { namespace: workspaceId } } },
      documents: [{
        kind: "Schedule", id: "sched-every-minute", digest: domainDigest("brain:sched:v1", { id: "sched-every-minute" } as never),
        spec: { workflow: { id: "fixture-workflow", digest: "sha256:" + "0".repeat(64) }, cron: "* * * * *", timezone: "UTC", misfire: "coalesce", maxCatchUp: 1, overlap: "skip", enabled: true },
      }],
    });
    store.control.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, manifest_json, created_at_ms) VALUES ('sha256:" + "1".repeat(64) + "', ?, 'sha1:" + "2".repeat(40) + "', 'sha256:" + "3".repeat(64) + "', ?, ?)")
      .run(org, manifest, clock.nowMs());
    store.control.prepare("INSERT INTO active_config(organization_id, release_digest, version) VALUES (?, 'sha256:" + "1".repeat(64) + "', 1)").run(org);
    return { store, dir, workspaceId, org };
  }

  const deps = {
    activeRelease: (organizationId: string) => {
      const row = depsStore.control.prepare("SELECT r.digest AS digest, r.manifest_json AS manifest FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?").get(organizationId) as { digest: string; manifest: string } | undefined;
      return row;
    },
    resolveWorkflow: (_organizationId: string, workflowId: string) => ({ workflow: { id: workflowId }, configDigest: "sha256:" + "1".repeat(64) }),
    startRun: (input: { executionKey: string; workflowId: string }) => {
      depsStarts.push(input);
      return { runId: `run-${depsStarts.length}` };
    },
  };
  let depsStore: Store;
  let depsStarts: Array<{ executionKey: string; workflowId: string }> = [];

  it("anchors at first sight, fires once per minute coalesced, and is idempotent on replay", () => {
    let now = Date.now();
    const clock = { nowMs: () => now };
    const w = world(clock);
    depsStore = w.store;
    depsStarts = [];

    // First sight anchors at now: nothing is due yet, and no historical catch-up.
    expect(runScheduledDispatch(w.store, deps).dispatched).toBe(0);

    // 90 seconds later the every-minute schedule has coalesced to one fire.
    now += 90_000;
    const first = runScheduledDispatch(w.store, deps);
    expect(first.dispatched).toBe(1);
    expect(depsStarts).toHaveLength(1);
    const marker = w.store.control.prepare("SELECT dispatch_id FROM schedule_fires WHERE schedule_id='sched-every-minute' AND dispatch_id LIKE 'run-%'").all() as Array<{ dispatch_id: string }>;
    expect(marker).toHaveLength(1);

    // A replay at the same instant is fully idempotent.
    expect(runScheduledDispatch(w.store, deps).dispatched).toBe(0);
    expect(depsStarts).toHaveLength(1);

    // One minute later exactly one further fire.
    now += 60_000;
    expect(runScheduledDispatch(w.store, deps).dispatched).toBe(1);
    expect(depsStarts).toHaveLength(2);
    // Distinct execution keys per fire.
    expect(depsStarts[0]!.executionKey).not.toBe(depsStarts[1]!.executionKey);
    w.store.close();
    rmSync(w.dir, { recursive: true, force: true });
  });

  it("disabled or malformed schedules are skipped without breaking the pass", () => {
    let now = Date.now();
    const clock = { nowMs: () => now };
    const w = world(clock);
    depsStore = w.store;
    depsStarts = [];
    w.store.control.prepare("UPDATE config_releases SET manifest_json=? WHERE organization_id=?").run(
      JSON.stringify({
        documents: [
          { kind: "Schedule", id: "sched-disabled", digest: "sha256:" + "4".repeat(64), spec: { workflow: { id: "fixture-workflow" }, cron: "* * * * *", timezone: "UTC", misfire: "skip", enabled: false } },
          { kind: "Schedule", id: "sched-bad-cron", digest: "sha256:" + "5".repeat(64), spec: { workflow: { id: "fixture-workflow" }, cron: "not a cron", timezone: "UTC", enabled: true } },
          { kind: "Workflow", id: "not-a-schedule", digest: "sha256:" + "6".repeat(64) },
        ],
      }),
      w.org,
    );
    now += 120_000;
    const result = runScheduledDispatch(w.store, deps);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    w.store.close();
    rmSync(w.dir, { recursive: true, force: true });
  });
});
