import { describe, expect, it } from "vitest";
import { goldenDocs, setupWorld } from "../helpers";
import { compileRelease } from "../../apps/governor/src/modules/configuration/index";

// T11 packet acceptance: staged immutable releases, dry-run compilation that
// persists nothing, CAS activation, and runs pinned to the release that was
// active at dispatch time.
const REV = "sha256:" + "3".repeat(64);

function changedDocs() {
  return goldenDocs().map((d) => d.path.endsWith("fixture-workflow.yaml")
    ? { ...d, text: d.text.replace("fixture \u2192 four-route", "fixture \u2192 four-route v2") }
    : d);
}

describe("config release staging and activation (T11)", () => {
  it("dry-run compilation persists nothing; staging requires config admin", () => {
    const w = setupWorld();
    const before = w.brain.activeRelease(w.org)!.digest;
    const compiled = compileRelease(changedDocs(), REV);
    expect(compiled.digest).not.toBe(before);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(before);
    const outsider = w.actor("mallory", w.workspaceId);
    expect(() => w.brain.stageRelease(outsider, changedDocs(), REV)).toThrow(/administration/);
    // Bad source revision shape is refused at admission.
    expect(() => w.brain.stageRelease(w.owner, changedDocs(), "rev-plain")).toThrow(/sourceRevision/);
    w.brain.close();
  });

  it("activation is CAS-guarded and existing runs keep their pinned release digest", () => {
    const w = setupWorld();
    const activeA = w.brain.activeRelease(w.org)!.digest;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-pin", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "pin-1",
      payload: { workflow: { id: "fixture-workflow", digest: activeA }, input: { message: "pinned" } },
    }, "pin-1");
    const { digest: digestB } = w.brain.stageRelease(w.owner, changedDocs(), REV);
    expect(digestB).not.toBe(activeA);
    // Stale CAS expectation fails; correct expectation succeeds exactly once.
    expect(() => w.brain.activateRelease(w.owner, digestB, "sha256:" + "9".repeat(64))).toThrow(/CAS failed/);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(activeA);
    w.brain.activateRelease(w.owner, digestB, activeA);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(digestB);
    expect(() => w.brain.activateRelease(w.owner, digestB, activeA)).toThrow(/CAS failed/);
    // The earlier run is still pinned to release A in the workspace record.
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const run = ws.prepare("SELECT config_digest FROM workflow_runs LIMIT 1").get() as { config_digest: string };
    expect(run.config_digest).toBe(activeA);
    // Activating an unstaged digest is NOT_FOUND, never a silent no-op.
    expect(() => w.brain.activateRelease(w.owner, "sha256:" + "8".repeat(64))).toThrow(/not found/);
    w.brain.close();
  });
});
