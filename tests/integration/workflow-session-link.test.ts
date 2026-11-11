import { describe, expect, it } from "vitest";
import type { BrainSession } from "@brain/contracts";
import { recordAttemptSession } from "../../apps/governor/src/modules/sessions/index";
import { operationalReadiness } from "../../apps/governor/src/modules/operations/readiness";
import { setupWorld, seedWorkItem, DIGEST_A } from "../helpers";

// A mission's Live tab shows the sessions that belong to its work items. A workflow run's session is created
// when a runner claims the attempt, so it has to be tied to the work item through the run's execution link
// at that moment; otherwise the tab says "Nobody is working" while the header says a task is running.
describe("workflow-run sessions belong to the mission's work item", () => {
  it("the native session recorded for a claimed attempt carries the work item of its run", async () => {
    const w = setupWorld();
    seedWorkItem(w.brain, w.org, w.workspaceId, "wi-live-link", "in-progress", ["done"]);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,created_at_ms) VALUES (?,?,?,?)").run("mission-wi-live-link", "wi-live-link", "run-live-link", w.brain.store.now());
    recordAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, jobId: "job-live-link", attemptId: "att-live-link", engineId: "fixture", adapterDigest: DIGEST_A, runId: "run-live-link" });
    const sessions = (await w.brain.executeQuery(w.owner, { queryType: "sessions.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: BrainSession[] } };
    const session = sessions.snapshot.items.find((entry) => entry.sessionId === "ses-job-live-link");
    expect(session?.workItemId).toBe("wi-live-link");
    expect(session?.task).toBe("seeded work item");
  });

  it("a finished, verified task counts as proof of the install", () => {
    const w = setupWorld();
    const before = operationalReadiness(w.brain.store, w.owner, w.workspaceId);
    expect(before.checks.find((check) => check.id === "smoke")?.status).toBe("unverified");
    seedWorkItem(w.brain, w.org, w.workspaceId, "wi-proof", "review", ["done"]);
    // The table itself refuses done without accepted evidence, so done is proof of a verified result.
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done',evidence_digest=?,updated_at_ms=? WHERE id='wi-proof'").run(DIGEST_A, w.brain.store.now());
    const after = operationalReadiness(w.brain.store, w.owner, w.workspaceId);
    expect(after.checks.find((check) => check.id === "smoke")?.status).toBe("ready");
  });
});
