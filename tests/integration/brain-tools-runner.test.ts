import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAIN_TOOL_COMMANDS, type AuditEntry, type EngineToolBinding, type MissionMessage, type PlanTask, type TeamMember, type WorkItemComment } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { GovernorClient } from "../../apps/runner/src/governor-client";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { BRAIN_BROKERED, BrainSession } from "../../apps/runner/src/tools/brain-tools";
import { brokerRead } from "../../apps/runner/src/tools/broker-read";
import { setupWorld } from "../helpers";
import { confirmedMission, stageStarter, task, type World } from "../support/machine-session";

// ADR 0042, runner side: the Brain tools of an attempt are Brain commands made over HTTP with the credential the Governor gave that attempt.
// The tool never names a command type or an id it cannot know; the Governor's authorization decides everything else.

const tmp = process.env["TMPDIR"] ?? "/tmp";
const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "checker", role: "Checker", agentId: "task-worker", engine: "fixture" },
];
const assigned = (id: string, memberId: string, extra: Partial<PlanTask> = {}): PlanTask => task(id, { assignment: { kind: "agent", id: memberId, role: "specialist" }, ...extra });

async function boot<T>(body: (context: { w: World; app: Awaited<ReturnType<typeof createApp>>; root: string; cfg: Parameters<typeof enrollAndHello>[0]; bearers: string[] }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmp, "brain-tools-runner-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  try {
    const w = setupWorld(app.brain);
    stageStarter(w);
    // Every bearer token the runner presents to the public command and query endpoints, to look for it in what the attempt recorded.
    const bearers: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (/\/v1\/(commands|query)$/u.test(new URL(request.url).pathname)) bearers.push((request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""));
      return app.fetch(request);
    };
    const stateDir = join(root, "agents");
    mkdirSync(stateDir, { recursive: true });
    const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-agents", stateDir, capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
    return await body({ w, app, root, cfg, bearers });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

const query = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;

describe("the Brain tools table", () => {
  it("maps four tools to four commands that only add notes, messages, handoffs and plan proposals", () => {
    expect(BRAIN_TOOL_COMMANDS).toEqual({
      "mission.propose-plan": "plan.propose", "mission.message-member": "mission.message.send", "mission.submit-handoff": "handoff.submit", "mission.comment": "workItem.comment",
    });
    expect([...BRAIN_BROKERED].sort()).toEqual(Object.keys(BRAIN_TOOL_COMMANDS).sort());
    // Nothing that judges, closes, approves or confirms can be reached through a tool.
    for (const type of Object.values(BRAIN_TOOL_COMMANDS)) expect(type).not.toMatch(/verdict|close|confirm|approv|policy|brief|budget|reject|activate/u);
  });
});

describe("a session's Brain tools, called as the runner makes them", () => {
  it("record a comment, a message, a handoff and a plan proposal as the member's principal, and say how each ended", async () => {
    await boot(async ({ w, cfg }) => {
      const { missionId } = await confirmedMission(w, { tasks: [assigned("a", "writer"), assigned("b", "checker")], team });
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);
      const offer = (await client.claim("claim-1"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      const brain = new BrainSession(client, offer.attemptId);
      const grant = await client.sessionCredential(offer.attemptId);
      const me = grant.memberId!;
      const other = me === "writer" ? "checker" : "writer";
      const principal = `agent:${missionId}:${me}`;

      const comment = await brain.call("mission.comment", { text: "The source table is stale" }, "p1");
      expect(comment).toMatchObject({ ok: true, data: { recorded: true } });
      const thread = (await query<{ items: WorkItemComment[] }>(w, "workItemComments.list", grant.workItemId)).items;
      expect(thread).toMatchObject([{ authorId: principal, authorKind: "agent", text: "The source table is stale" }]);

      const message = await brain.call("mission.message-member", { memberId: other, body: "Use the 2025 figures" }, "p2");
      expect(message).toMatchObject({ ok: true, data: { recorded: true } });
      expect((await query<{ items: MissionMessage[] }>(w, "missionMessages.list", missionId)).items[0]).toMatchObject({ senderId: principal, senderKind: "agent", senderMemberId: me, recipient: { kind: "member", memberId: other } });

      const handoff = await brain.call("mission.submit-handoff", { summary: "Done; see the table", nextAction: "Review it" }, "p3");
      expect(handoff).toMatchObject({ ok: true, data: { recorded: true } });
      expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT submitted_by FROM handoffs WHERE work_item_id=?").get(grant.workItemId)).toEqual({ submitted_by: principal });

      // Inside the autonomy policy (standard allows adding a task) the proposal is confirmed, and the result says so.
      const tasks = [assigned("a", "writer"), assigned("b", "checker"), assigned("c", other, { dependsOn: ["b"] })];
      const confirmed = await brain.call("mission.propose-plan", { summary: "A check after b", tasks, team }, "p4");
      expect(confirmed).toMatchObject({ ok: true, data: { state: "confirmed", outcome: expect.stringMatching(/inside the mission's autonomy policy/u) } });
      // Outside it (a role nobody has), it waits for a person, and the result tells the model not to propose it again.
      const auditor: TeamMember = { memberId: "auditor", role: "Auditor", agentId: "task-worker", engine: "fixture" };
      const waiting = await brain.call("mission.propose-plan", { tasks: [...tasks, assigned("d", "auditor")], team: [...team, auditor] }, "p5");
      expect(waiting).toMatchObject({ ok: true, data: { state: "proposed", outcome: expect.stringMatching(/waits for a person.*Do not propose it again/su) } });
      expect((w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM plan_versions WHERE mission_id=? ORDER BY revision DESC LIMIT 1").get(missionId) as { state: string }).state).toBe("proposed");

      const acted = ((await query<{ items: AuditEntry[] }>(w, "audit.list")).items).filter((entry) => entry.action === "session.acted");
      expect(acted).toHaveLength(5);
      for (const entry of acted) expect(entry).toMatchObject({ actorId: principal, actingFor: w.owner.actorId });
    });
  });

  it("refuse in plain words what the principal may not do, and a repeat of the same call is the same command", async () => {
    await boot(async ({ w, cfg }) => {
      const { missionId, workItemId } = await confirmedMission(w, { tasks: [assigned("a", "writer"), assigned("b", "checker")], team });
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);
      const offer = (await client.claim("claim-1"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      const brain = new BrainSession(client, offer.attemptId);
      const me = (await client.sessionCredential(offer.attemptId)).memberId!;
      const other = me === "writer" ? "checker" : "writer";

      // Not itself, not a stranger.
      expect(await brain.call("mission.message-member", { memberId: me, body: "to myself" }, "r1")).toMatchObject({ ok: false, error: expect.stringMatching(/does not message its own team member.*Do not retry/su) });
      expect(await brain.call("mission.message-member", { memberId: "ghost", body: "anyone?" }, "r2")).toMatchObject({ ok: false, error: expect.stringMatching(/not on the mission team/u) });
      // A work item of another mission is out of reach, even named by id; and an id smuggled in for the mission is never used.
      const elsewhere = (await confirmedMissionElsewhere(w)).workItemId;
      expect(await brain.call("mission.comment", { text: "Wandering", workItemId: elsewhere }, "r3")).toMatchObject({ ok: false, error: expect.stringMatching(/only act on its own mission/u) });
      expect(await brain.call("mission.comment", { text: "Still mine", missionId: "mission-elsewhere" }, "r4")).toMatchObject({ ok: true });
      // The same proposal id is one command: a retry after a crash adds no second comment.
      await brain.call("mission.comment", { text: "Once" }, "r5");
      await brain.call("mission.comment", { text: "Once" }, "r5");
      const own = (await client.sessionCredential(offer.attemptId)).workItemId!;
      const texts = (await query<{ items: WorkItemComment[] }>(w, "workItemComments.list", own)).items.map((entry) => entry.text);
      expect(texts.filter((text) => text === "Once")).toHaveLength(1);
      void missionId; void workItemId; void other;
    });
  });

  it("ask for a fresh credential when the held one is about to expire, and the old one stops working", async () => {
    await boot(async ({ w, cfg, bearers }) => {
      await confirmedMission(w, { tasks: [assigned("a", "writer"), assigned("b", "checker")], team });
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      const client = new GovernorClient(cfg);
      client.setToken(session.sessionToken);
      const offer = (await client.claim("claim-1"))!;
      await client.ack(offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      let asked = 0;
      const counting = { sessionCredential: (attemptId: string) => { asked++; return client.sessionCredential(attemptId); }, actAs: client.actAs.bind(client) };
      let clock = Date.now();
      const brain = new BrainSession(counting, offer.attemptId, () => clock);
      await brain.call("mission.comment", { text: "one" }, "e1");
      await brain.call("mission.comment", { text: "two" }, "e2");
      expect(asked).toBe(1);
      clock += 3_600_000;
      expect(await brain.call("mission.comment", { text: "three" }, "e3")).toMatchObject({ ok: true });
      expect(asked).toBe(2);
      const [first, , , last] = bearers.filter((token, index, all) => all.indexOf(token) === index && token !== "");
      expect(first).toBeTruthy();
      // The first credential was replaced when the second was issued.
      const stale = await client.actAs(first!, "/v1/commands", { contractVersion: "brain.command/v1", commandId: "stale", commandType: "workItem.comment", workspaceId: w.workspaceId, idempotencyKey: "stale", payload: { workItemId: (await client.sessionCredential(offer.attemptId)).workItemId, text: "stale" } });
      expect(stale.status).toBeGreaterThanOrEqual(400);
      void last;
    });
  });

  it("are refused outside a mission session: a direct tool step has no principal to act as", async () => {
    const binding = { release: { id: "mission.comment", digest: `sha256:${"a".repeat(64)}` }, effectClass: "read", inputSchema: {}, target: { targetId: "tool:mission.comment", environmentId: "local", preconditionDigest: `sha256:${"a".repeat(64)}` } } as unknown as EngineToolBinding;
    const refused = await brokerRead(binding, { text: "hello" }, "attempt-x", { toolRead: async () => ({}) });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/only inside a mission session/u) });
  });
});

async function confirmedMissionElsewhere(w: World): Promise<{ workItemId: string }> {
  const other = (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-else", commandType: "mission.create", workspaceId: w.workspaceId, idempotencyKey: "else", payload: { title: "Elsewhere", intent: "Another mission", successCriteria: ["x"] } } as never, "else")).receipt.resourceId!;
  const planId = (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-else-plan", commandType: "plan.propose", workspaceId: w.workspaceId, idempotencyKey: "else-plan", payload: { missionId: other, origin: "manual", tasks: [{ id: "z", title: "Task z", criteria: ["z is done"], dependsOn: [] }] } } as never, "else-plan")).receipt.resourceId!;
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: other })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-else-confirm", commandType: "plan.confirm", workspaceId: w.workspaceId, idempotencyKey: "else-confirm", expectedVersion: version, payload: { planVersionId: planId } } as never, "else-confirm");
  return { workItemId: (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(other) as { id: string }).id };
}

describe("an agent attempt calling Brain tools end to end (supervisor, fixture engine, Governor, pinned scripts)", () => {
  it("makes the calls through the pinned tools, records them as tool events, and the credential is never in anything the attempt recorded", async () => {
    await boot(async ({ w, cfg, bearers }) => {
      const call = (id: string, input: Record<string, unknown>) => `FIXTURE_CALL_TOOL ${JSON.stringify({ id, input })}`;
      const refusedPlan = { tasks: [{ id: "z", title: "Nothing of a", criteria: ["z is done"], dependsOn: [] }] };
      const writing = assigned("a", "writer", { criteria: [
        call("mission.comment", { text: "The source table is stale" }),
        call("mission.message-member", { memberId: "checker", body: "Use the 2025 figures" }),
        call("mission.submit-handoff", { summary: "Done; see the table", nextAction: "Review it" }),
        call("mission.message-member", { memberId: "writer", body: "to myself" }),
        call("mission.propose-plan", refusedPlan),
      ] });
      const { missionId, workItemId } = await confirmedMission(w, { tasks: [writing, assigned("b", "checker", { dependsOn: ["a"] })], team });
      const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
      expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
      const attempt = w.brain.store.control.prepare("SELECT id FROM job_attempts ORDER BY rowid LIMIT 1").get() as { id: string };

      const events = (w.brain.store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attempt.id) as Array<{ event_json: string }>).map((row) => row.event_json);
      const results = events.map((json) => (JSON.parse(json) as { payload: { kind?: string; payload: { receipt?: { result: string; stdout: { digest: string } } } } }).payload).filter((entry) => entry.kind === "tool.result");
      expect(results).toHaveLength(5);
      const outputs = results.map((entry) => ({ result: entry.payload.receipt!.result, output: JSON.parse(new TextDecoder().decode(readVerified(w.brain.store, entry.payload.receipt!.stdout.digest))) as Record<string, unknown> }));
      expect(outputs.map((entry) => entry.result)).toEqual(["succeeded", "succeeded", "succeeded", "failed", "failed"]);
      expect(outputs[0]!.output).toMatchObject({ recorded: true, note: expect.stringMatching(/does not reach anyone/u) });
      expect(JSON.stringify(outputs[3]!.output)).toMatch(/does not message its own team member/u);
      expect(JSON.stringify(outputs[4]!.output)).toMatch(/started work/u);

      const principal = `agent:${missionId}:writer`;
      expect((await query<{ items: WorkItemComment[] }>(w, "workItemComments.list", workItemId)).items).toMatchObject([{ authorId: principal, text: "The source table is stale" }]);
      expect((await query<{ items: MissionMessage[] }>(w, "missionMessages.list", missionId)).items).toMatchObject([{ senderId: principal, senderKind: "agent", recipient: { memberId: "checker" }, body: "Use the 2025 figures" }]);
      expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT submitted_by FROM handoffs WHERE work_item_id=?").get(workItemId)).toEqual({ submitted_by: principal });
      expect(((await query<{ items: AuditEntry[] }>(w, "audit.list")).items).filter((entry) => entry.action === "session.acted")).toHaveLength(3);

      // The credential the runner used is nowhere in what the attempt recorded: events, tool outputs, uploaded artifacts.
      const credentials = [...new Set(bearers)].filter((token) => token !== "" && token !== session.sessionToken);
      expect(credentials.length).toBeGreaterThan(0);
      const recorded = [...events, ...outputs.map((entry) => JSON.stringify(entry.output))];
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [readFileSync(join(dir, entry.name), "utf8")]));
      const stored = walk(join(w.brain.store.dataDir, "cas"));
      // The search must have had something to read: the tool outputs and the agent's own result were uploaded as artifacts of the attempt.
      expect(stored.length).toBeGreaterThanOrEqual(6);
      for (const credential of credentials) for (const text of [...recorded, ...stored]) expect(text).not.toContain(credential);
    });
  });
});
