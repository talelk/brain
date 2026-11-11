import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext } from "@brain/contracts";
import { JobProtocol } from "../../apps/governor/src/modules/jobs/index";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";
import { Store } from "../../apps/governor/src/application/store";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function world(clock: { nowMs: () => number }) {
  const dir = mkdtempSync(join(tmpdir(), "brain-repeat-"));
  const store = new Store({ dataDir: dir, allowTestActor: true, clock: clock as never });
  const org = "org-rep";
  const workspaceId = "ws-rep";
  store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES (?, 'auth-rep')").run(org);
  store.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES (?, ?, 'rep', 'active')").run(workspaceId, org);
  store.control.prepare("INSERT INTO principals(id, organization_id, kind, auth_subject_id) VALUES ('operator-1', ?, 'human', 'rep-operator')").run(org);
  store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,'operator-1','workspace-lead',1,'operator-1',?)").run(workspaceId, org, clock.nowMs());
  let runCounter = 0;
  const service = new JobProtocol(store, {
    completeStep: () => undefined, evaluatorEligible: () => true, runnerCurrent: () => true, activeRelease: () => undefined,
    resolveWorkflow: (_o: string, workflowId: string) => ({ workflow: { id: workflowId }, configDigest: `sha256:${"1".repeat(64)}` }),
    startRun: (input: { executionKey: string }) => {
      const runId = `run-rep-${++runCounter}`;
      store.workspaceDb(workspaceId, org).prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,version,wait_generation,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(runId, input.executionKey, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `eng-${runId}`, "succeeded", 1, 0, `sha256:${"4".repeat(64)}`, clock.nowMs());
      return { runId };
    },
  }).automations;
  const actor: ActorContext = { kind: "human", actorId: "operator-1", organizationId: org, workspaceId, scopes: ["workspace:read", "workflow:dispatch"], authMethod: "session", authGeneration: 1 };
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const setResult = (runId: string, body: unknown) => {
    const stored = putBytes(store, new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));
    store.workspaceDb(workspaceId, org).prepare("UPDATE workflow_runs SET output_digest=? WHERE id=?").run(stored, runId);
  };
  return { store, service, actor, workspaceId, setResult };
}

const asJson = <T,>(value: unknown) => value as T;

describe("Repeat this: server-side presets and occurrence diff (#56 #57)", () => {
  it("maps each preset to a cron and previews the next five instants in the chosen timezone", () => {
    const clock = { nowMs: () => Date.parse("2026-11-11T10:00:00Z") };
    const w = world(clock);
    const view = asJson<{ timezone: string; presets: Array<{ presetId: string; cron: string; timezone: string; nextOccurrences: string[] }> }>(w.service.query(w.actor, "automations.preview", w.workspaceId, undefined, 100, "Europe/Paris"));
    expect(view.presets.map((preset) => preset.presetId)).toEqual(["weekdays-0800", "weekly-monday-0800", "monthly-first-0800"]);
    const weekdays = view.presets[0]!;
    expect(weekdays.cron).toBe("0 8 * * 1-5");
    expect(weekdays.timezone).toBe("Europe/Paris");
    expect(weekdays.nextOccurrences).toHaveLength(5);
    // 08:00 in Paris in November is 07:00Z; Thursday 12 Nov is the next weekday after the 11th 10:00Z.
    expect(weekdays.nextOccurrences[0]).toBe("2026-11-12T07:00:00.000Z");
    expect(view.presets[2]!.nextOccurrences[0]).toBe("2026-12-01T07:00:00.000Z");
    expect(() => w.service.query(w.actor, "automations.preview", w.workspaceId, undefined, 100, "Mars/Olympus")).toThrow(/timezone/);
    expect(() => w.service.query(w.actor, "automations.preview", w.workspaceId, "nope", 100, "UTC")).toThrow(/preset/);
  });

  it("says first run, then unchanged or what changed, and waits when a result is missing", () => {
    let now = Date.parse("2026-11-11T10:00:00Z");
    const w = world({ nowMs: () => now });
    const id = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Weekday report", target: { kind: "workflow", id: "general-task" }, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, input: { situation: "report" } } });
    let day = Date.parse("2026-11-12T08:00:00Z");
    const fire = () => { now = day + 5_000; day += 24 * 3600_000; w.service.dispatchAll(); };
    type Diff = { kind: string; previous?: { occurrenceId: string }; outputs: Array<{ status: string; added: number; removed: number; hunks: Array<{ lines: Array<{ type: string; text: string }> }> }> };
    const diff = (ref: string) => asJson<Diff>(w.service.query(w.actor, "automations.diff", w.workspaceId, ref));
    const occurrences = () => asJson<{ items: Array<{ occurrenceId: string; dispatchRef?: string; state: string }> }>(w.service.query(w.actor, "automations.occurrences", w.workspaceId, id)).items.filter((item) => item.state === "dispatched").reverse();

    fire();
    const first = occurrences()[0]!;
    expect(diff(first.occurrenceId).kind).toBe("first-run");
    expect(diff(first.dispatchRef!).kind).toBe("first-run");

    fire();
    const second = occurrences()[1]!;
    expect(diff(second.occurrenceId)).toMatchObject({ kind: "previous-pending" });
    w.setResult(first.dispatchRef!, { summary: "a", deliverable: "# Report\n- alpha\n- beta" });
    w.setResult(second.dispatchRef!, { summary: "b", deliverable: "# Report\n- alpha\n- beta" });
    // Different summaries but the same written deliverable: nothing changed.
    expect(diff(second.occurrenceId).kind).toBe("unchanged");

    fire();
    const third = occurrences()[2]!;
    w.setResult(third.dispatchRef!, { summary: "c", deliverable: "# Report\n- alpha\n- gamma\n- delta" });
    const changed = diff(third.occurrenceId);
    expect(changed.kind).toBe("changed");
    expect(changed.previous?.occurrenceId).toBe(second.occurrenceId);
    expect(changed.outputs[0]).toMatchObject({ status: "changed", added: 2, removed: 1 });
    const lines = changed.outputs[0]!.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.filter((line) => line.type === "add").map((line) => line.text)).toEqual(["- gamma", "- delta"]);
    expect(lines.filter((line) => line.type === "del").map((line) => line.text)).toEqual(["- beta"]);
    expect(() => diff("nothing")).toThrow(/not found/);
  });
});
