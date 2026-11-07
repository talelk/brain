import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { TaskExperience } from "../../apps/governor/src/modules/workflows/index";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function world() {
 const dir = mkdtempSync(join(tmpdir(), "brain-task-experience-")); const app = await createApp({ dataDir: dir, allowTestActor: true }); const w = setupWorld(app.brain);
 cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
 const bundle = fixtureStarter(); const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas); w.brain.activateRelease(w.owner, release.digest);
 const tasks = new TaskExperience(w.brain.store, { query: (actor, query) => w.brain.executeQuery(actor, query), dispatch: async (actor, command) => ({ receipt: (await w.brain.executeCommand(actor, command, "task-test")).receipt }) });
 return { ...w, app, tasks };
}
it("requires explicit start, recovers an accepted command and links the originating work item", async () => {
 const w = await world(); const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
 db.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('objective-context','Investigate latency','Diagnose latency','[\"latency-explained\"]','owner-1',?,?)").run(Date.now(), Date.now());
 db.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-context','objective-context',1,?,'confirmed','manual','owner-1','[]',?)").run(DIGEST_A, Date.now());
 db.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('card-context','objective-context','plan-context','investigate','Investigate latency','ready','[\"latency-explained\"]','Start this task',?,?)").run(Date.now(), Date.now());
 const origin = { kind: "work-item" as const, id: "card-context" };
 const draft = await w.tasks.prepare(w.owner, { workspaceId: w.workspaceId, workflowId: "operations-triage", input: { situation: "Latency increased" }, origin });
 expect(db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 0 });
 const started = await w.tasks.start(w.owner, w.workspaceId, draft.id); expect(started.runId).toBeTruthy();
 // Simulate a lost association write after durable command acceptance.
 db.prepare("UPDATE task_drafts SET state='review',run_id=NULL WHERE id=?").run(draft.id);
 const changed = fixtureStarter(); changed.instructions[0]!.text += "\nChanged after acceptance.\n";
 const replacement = w.brain.stageRelease(w.owner, changed.documents, changed.sourceRevision, changed.scripts, changed.instructions, changed.schemas);
 w.brain.activateRelease(w.owner, replacement.digest);
 expect((await w.tasks.start(w.owner, w.workspaceId, draft.id)).runId).toBe(started.runId);
 expect(db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 1 });
 expect((await w.tasks.context(w.owner, w.workspaceId, origin)).runs[0]?.runId).toBe(started.runId);
 await expect(w.tasks.start({ ...w.owner, scopes: [] }, w.workspaceId, draft.id)).rejects.toThrow();
 await expect(w.tasks.prepare(w.owner, { workspaceId: w.workspaceId, workflowId: "operations-triage", input: {}, origin })).rejects.toThrow();
 await expect(w.tasks.context(w.owner, w.workspaceId, { kind: "work-item", id: "other-workspace-card" })).rejects.toThrow(/not found/);
});
it("rejects a stale task review while retaining its inputs", async () => {
 const w = await world(); const draft = await w.tasks.prepare(w.owner, { workspaceId: w.workspaceId, workflowId: "support-draft", input: { title: "Session", body: "Expired" } });
 w.brain.store.control.prepare("DELETE FROM active_config WHERE organization_id=?").run(w.org);
 await expect(w.tasks.start(w.owner, w.workspaceId, draft.id)).rejects.toThrow();
 expect(w.tasks.getDraft(w.owner, w.workspaceId, draft.id).input).toEqual({ title: "Session", body: "Expired" });
});
it("conversation executes only the guide and offers an independently verified inert proposal", async () => {
 const w = await world(); const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
 await w.tasks.createConversation(w.owner, w.workspaceId, "thread-test");
 const sent = await w.tasks.message(w.owner, w.workspaceId, "thread-test", "message-test", "Draft a support reply for an expired session");
 expect(sent.messages.some((message) => message.state === "pending")).toBe(true);
 expect((await w.tasks.message(w.owner, w.workspaceId, "thread-test", "message-test", "Draft a support reply for an expired session")).messages.length).toBe(2);
 expect(w.tasks.conversations(w.owner, w.workspaceId)[0]?.id).toBe("thread-test");
 await expect(w.tasks.message(w.owner, w.workspaceId, "thread-test", "message-test", "Changed text")).rejects.toThrow(/different text/);
 const transport: typeof fetch = async (input, init) => w.app.fetch(new Request(input, init));
 for (const group of ["agents", "evaluators"]) {
  const config = { governorUrl: "http://127.0.0.1:3000", runnerId: `chat-${group}`, stateDir: join(w.dir, group), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
  const session = await enrollAndHello(config, w.brain.jobProtocol.issueEnrollment(w.owner, group).token);
  expect(await runOnce(config, session.sessionToken, session.epoch)).toBe(true);
 }
 const result = await w.tasks.conversation(w.owner, w.workspaceId, "thread-test");
 const proposal = result.messages.find((message) => message.draftId); expect(proposal?.draftId).toBeTruthy();
 const draft = w.tasks.getDraft(w.owner, w.workspaceId, proposal!.draftId!); expect(draft.workflow.id).toBe("support-draft"); expect(draft.state).toBe("review");
 expect(db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 1 });
 await expect(w.tasks.conversation({ ...w.owner, actorId: "another-human" }, w.workspaceId, "thread-test")).rejects.toThrow();
});

it("turns an objective into an independently validated plan and materializes it only after confirmation (E101)", async () => {
 const w = await world(); const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
 const started = await w.tasks.startMissionPlan(w.owner, { workspaceId: w.workspaceId, requestId: "plan-e2e", title: "Stabilize authentication", intent: "Resolve expired user sessions", successCriteria: ["Users remain signed in"] });
 expect(started.state).toBe("running");
 expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 0 });
 const transport: typeof fetch = async (input, init) => w.app.fetch(new Request(input, init));
 for (const group of ["agents", "evaluators"]) {
  const config = { governorUrl: "http://127.0.0.1:3000", runnerId: `plan-${group}`, stateDir: join(w.dir, group), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
  const session = await enrollAndHello(config, w.brain.jobProtocol.issueEnrollment(w.owner, group).token);
  expect(await runOnce(config, session.sessionToken, session.epoch)).toBe(true);
 }
 const proposal = await w.tasks.missionPlan(w.owner, w.workspaceId, started.missionId);
 expect(proposal.state).toBe("ready");
 expect(proposal.plan?.tasks.map((task) => task.id)).toEqual(["investigate", "implement", "review"]);
 expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 0 });
 const confirmed = await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "confirm-plan-e2e", commandType: "plan.confirm", workspaceId: w.workspaceId, idempotencyKey: "confirm-plan-e2e", expectedVersion: 1, payload: { planVersionId: proposal.planVersionId } }, "plan-test");
 expect(confirmed.receipt.accepted).toBe(true);
 expect(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()).toEqual({ n: 3 });
 expect((await w.tasks.missionPlan(w.owner, w.workspaceId, started.missionId)).planVersionId).toBe(proposal.planVersionId);
});
