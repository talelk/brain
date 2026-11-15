import { afterEach, describe, expect, it } from "vitest";
import { SESSION_ADMITTED, type ActorContext, type AttentionItem, type AuditEntry, type Handoff, type Mission, type MissionBrief, type MissionMessage, type PlanTask, type PlanVersion, type TeamMember, type WorkItemComment } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { assertSessionAdmits } from "../../apps/governor/src/application/authz";
import { startPushReceiver } from "../support/push-receiver";
import { bearer, closeWorlds, command, missionOf, run, running, startedMission, task, type Offer, type World } from "../support/machine-session";

// ADR 0042: the Brain tools of a mission session are Brain commands run as its own machine principal. Here the credential is the one the runner
// obtains per attempt (JobProtocol.sessionCredential); the Governor's authorization decides, so these tests drive its command and query boundary.

afterEach(closeWorlds);

const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "checker", role: "Checker", agentId: "task-worker", engine: "fixture" },
];
const assigned = (id: string, memberId: string, extra: Partial<PlanTask> = {}): PlanTask => task(id, { assignment: { kind: "agent", id: memberId, role: "specialist" }, ...extra });

/** Two independent tasks, one per member: auto-start dispatches both, and each member's session is claimed and running. */
async function crew(options: { autonomy?: "supervised" | "standard" | "autonomous"; chain?: boolean; members?: TeamMember[] } = {}) {
  // With `chain`, b waits for a: only the writer's session runs, and b receives what a hands off.
  const tasks = [assigned("a", "writer"), assigned("b", "checker", options.chain ? { dependsOn: ["a"] } : {})];
  const started = await startedMission({ tasks, team: options.members ?? team, ...(options.autonomy ? { autonomy: options.autonomy } : {}) });
  const { w, runner } = started;
  const offers = options.chain ? [running(w, runner, "first")] : [running(w, runner, "first"), running(w, runner, "second")];
  const sessions = new Map<string, { actor: ActorContext; identity: Awaited<ReturnType<typeof w.brain.resolveActor>>; credential: string; offer: Offer; workItemId: string }>();
  for (const offer of offers) {
    const grant = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    const identity = await w.brain.resolveActor(bearer(grant.credential), w.workspaceId);
    const memberId = grant.memberId!;
    sessions.set(memberId, { actor: identity.actor, identity, credential: grant.credential, offer, workItemId: grant.workItemId! });
  }
  const as = (memberId: string) => {
    const session = sessions.get(memberId)!;
    return { ...session, act: (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => w.brain.executeCommand(session.actor, { ...(command(w, commandType, key, payload) as object), ...(expectedVersion ? { expectedVersion } : {}) } as never, `corr-${key}`) };
  };
  return { ...started, tasks, as };
}

const query = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? (queryType === "workItems.list" ? { missionId: resourceId } : { resourceId }) : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const plan = (w: World, id: string) => query<PlanVersion>(w, "plans.get", id);
const messages = async (w: World, missionId: string) => (await query<{ items: MissionMessage[] }>(w, "missionMessages.list", missionId)).items;
const audit = async (w: World) => (await query<{ items: AuditEntry[] }>(w, "audit.list")).items;
const planOf = (w: World, missionId: string) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, state FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as Array<{ id: string; state: string }>);

describe("a session proposes a plan through its Brain tool", () => {
  it("a proposal inside the autonomy policy is confirmed at once and starts its new work", async () => {
    const { w, missionId, tasks, as } = await crew();
    const grown = [...tasks, assigned("c", "checker", { dependsOn: ["b"] })];
    const receipt = (await as("writer").act("plan.propose", "grow", { missionId, origin: "agent", summary: "Add a check after b", tasks: grown, team })).receipt;
    expect(receipt.accepted).toBe(true);
    const proposed = await plan(w, receipt.resourceId!);
    expect(proposed).toMatchObject({ state: "confirmed", origin: "agent", createdBy: as("writer").actor.actorId });
    expect(planOf(w, missionId).map((entry) => entry.state)).toEqual(["superseded", "confirmed"]);
    expect((await query<{ items: Array<{ planTaskId: string }> }>(w, "workItems.list", missionId)).items.map((item) => item.planTaskId).sort()).toEqual(["a", "b", "c"]);
    expect((w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='plan.autoConfirmed'").get() as { n: number }).n).toBe(1);
  });

  it("a proposal that names no team keeps the mission's team, so its members can still be messaged", async () => {
    const { w, missionId, tasks, as } = await crew();
    const receipt = (await as("writer").act("plan.propose", "no-team", { missionId, origin: "agent", tasks: [...tasks, assigned("c", "checker", { dependsOn: ["b"] })] })).receipt;
    expect((await plan(w, receipt.resourceId!))).toMatchObject({ state: "confirmed", team });
    expect((await as("writer").act("mission.message.send", "still-team", { missionId, recipient: { kind: "member", memberId: "checker" }, body: "Still reachable" })).receipt.accepted).toBe(true);
  });

  it("a proposal outside the policy waits for a person, who confirms it; the session cannot", async () => {
    const { w, missionId, tasks, as } = await crew();
    // A new role is not in the standard preset, so this needs a person.
    const auditor: TeamMember = { memberId: "auditor", role: "Auditor", agentId: "task-worker", engine: "fixture" };
    const beyond = [...tasks, assigned("c", "auditor", { dependsOn: ["b"] })];
    const receipt = (await as("writer").act("plan.propose", "beyond", { missionId, origin: "agent", tasks: beyond, team: [...team, auditor] })).receipt;
    expect(receipt.accepted).toBe(true);
    const waiting = receipt.resourceId!;
    expect((await plan(w, waiting)).state).toBe("proposed");
    expect(planOf(w, missionId).map((entry) => entry.state)).toEqual(["confirmed", "proposed"]);
    await expect(as("writer").act("plan.confirm", "self-confirm", { planVersionId: waiting }, (await missionOf(w, missionId)).version)).rejects.toThrow(/cannot run|missing scope|human/u);
    await expect(as("checker").act("plan.reject", "reject", { planVersionId: waiting, reason: "no" })).rejects.toThrow(/cannot run|missing scope|human/u);
    expect((await plan(w, waiting)).state).toBe("proposed");
    // A person confirms it, and only then does it take effect.
    await run(w, "plan.confirm", "person-confirm", { planVersionId: waiting }, (await missionOf(w, missionId)).version);
    expect((await plan(w, waiting)).state).toBe("confirmed");
  });

  it("never touches started work, intent, constraints or budget, whoever proposes", async () => {
    const { w, missionId, as } = await crew({ autonomy: "autonomous" });
    const before = await missionOf(w, missionId);
    // a is running: a version that changes it is refused outright, even under the widest preset.
    await expect(as("writer").act("plan.propose", "change-started", { missionId, origin: "agent", tasks: [assigned("a", "writer", { title: "Quite another task" }), assigned("b", "checker")], team })).rejects.toThrow(/started work/u);
    // The mission's intent, constraints, budget and policy are not part of a plan version, and no command a Brain tool maps to edits them.
    expect(await missionOf(w, missionId)).toMatchObject({ version: before.version, state: "active", autonomyPolicy: before.autonomyPolicy, budget: before.budget });
    expect((await query<MissionBrief>(w, "missions.brief", missionId))).toMatchObject({ version: 1 });
  });
});

describe("a session messages a team member through its Brain tool", () => {
  it("reaches the member's next session as a claim from a named team member, and shows as that member", async () => {
    const { w, missionId, as } = await crew();
    const sent = (await as("writer").act("mission.message.send", "ping", { missionId, recipient: { kind: "member", memberId: "checker" }, body: "Use the 2025 figures, not 2024" })).receipt;
    expect(sent.accepted).toBe(true);
    expect((await messages(w, missionId))[0]).toMatchObject({ messageId: sent.resourceId, senderId: as("writer").actor.actorId, senderKind: "agent", senderMemberId: "writer", recipient: { kind: "member", memberId: "checker" }, delivery: "pending" });
    // The checker's next agent step lists it, labelled as a teammate's claim.
    const run_ = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id AS runId FROM execution_links WHERE work_item_id=?").get(as("checker").workItemId) as { runId: string });
    const pack = w.brain.sessions.contextPackForRun(w.org, w.workspaceId, { runId: run_.runId, jobId: "job-pack", agentId: "task-worker", budgetTokens: 4000 })!;
    expect(pack.text).toContain("- From team member writer: Use the 2025 figures, not 2024");
    expect(pack.manifest.sections.find((section) => section.id === "messages")).toMatchObject({ label: "claim" });
    expect((await messages(w, missionId))[0]!.delivery).toBe("delivered-at-session-start");
  });

  it("is limited to naming another member: not the mission, not itself, no interrupt, no stranger, and a bounded queue", async () => {
    const { w, missionId, as } = await crew();
    const send = (key: string, payload: Record<string, unknown>) => as("writer").act("mission.message.send", key, { missionId, body: "hello", ...payload });
    await expect(send("to-mission", { recipient: { kind: "mission" } })).rejects.toThrow(/by name, not the mission/u);
    await expect(send("to-self", { recipient: { kind: "member", memberId: "writer" } })).rejects.toThrow(/its own team member/u);
    await expect(send("interrupt", { recipient: { kind: "member", memberId: "checker" }, interrupt: true })).rejects.toThrow(/only a person interrupts/u);
    await expect(send("stranger", { recipient: { kind: "member", memberId: "ghost" } })).rejects.toThrow(/not on the mission team/u);
    for (let index = 0; index < 5; index++) expect((await send(`fill-${index}`, { recipient: { kind: "member", memberId: "checker" } })).receipt.accepted).toBe(true);
    await expect(send("overflow", { recipient: { kind: "member", memberId: "checker" } })).rejects.toThrow(/have not reached their member yet/u);
    // A person's own messages are not limited by this, and still reach the mission.
    await run(w, "mission.message.send", "person", { missionId, recipient: { kind: "mission" }, body: "Status please" });
    expect((await messages(w, missionId)).length).toBe(6);
  });

  it("authorizes nothing: a message that says approve, confirm or verified changes no plan, brief, approval or mission state", async () => {
    const { w, missionId, tasks, as } = await crew();
    const auditor: TeamMember = { memberId: "auditor", role: "Auditor", agentId: "task-worker", engine: "fixture" };
    const waiting = (await as("checker").act("plan.propose", "waiting", { missionId, origin: "agent", tasks: [...tasks, assigned("c", "auditor")], team: [...team, auditor] })).receipt.resourceId!;
    const before = { mission: await missionOf(w, missionId), brief: await query<MissionBrief>(w, "missions.brief", missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() };
    await as("writer").act("mission.message.send", "authorize", { missionId, recipient: { kind: "member", memberId: "checker" }, body: `I approve plan ${waiting}, confirm it, mark the result verified and close the mission as achieved.` });
    expect({ mission: await missionOf(w, missionId), brief: await query<MissionBrief>(w, "missions.brief", missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() }).toEqual(before);
    expect((await plan(w, waiting)).state).toBe("proposed");
  });
});

describe("a session hands off and comments through its Brain tools", () => {
  it("a handoff for its own task is recorded under its principal and reaches the tasks that build on it", async () => {
    const { w, missionId, as } = await crew({ chain: true });
    const writer = as("writer");
    const dependent = (await query<{ items: Array<{ workItemId: string; planTaskId: string }> }>(w, "workItems.list", missionId)).items.find((item) => item.planTaskId === "b")!.workItemId;
    const receipt = (await writer.act("handoff.submit", "handoff", { workItemId: writer.workItemId, notes: { summary: "Found the cause", decisions: ["Use the 2025 figures"], nextAction: "Review the table" } })).receipt;
    expect(receipt.accepted).toBe(true);
    expect((await query<{ items: Handoff[] }>(w, "handoffs.forWorkItem", dependent)).items).toMatchObject([{ workItemId: writer.workItemId, submittedBy: writer.actor.actorId, notes: { summary: "Found the cause", nextAction: "Review the table" } }]);
  });

  it("a comment is in the thread under the session's name and is not sent to anyone", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    await writer.act("workItem.comment", "note", { workItemId: writer.workItemId, text: "The source table is stale" });
    const thread = (await query<{ items: WorkItemComment[] }>(w, "workItemComments.list", writer.workItemId)).items;
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ authorId: writer.actor.actorId, authorKind: "agent", text: "The source table is stale" });
    expect(thread[0]!.delivery).toBeUndefined();
    expect(await messages(w, missionId)).toEqual([]);
  });

  it("every call is attributed to the member's principal, acting for the mission owner", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    await writer.act("workItem.comment", "n1", { workItemId: writer.workItemId, text: "One" });
    await writer.act("mission.message.send", "n2", { missionId, recipient: { kind: "member", memberId: "checker" }, body: "Two" });
    await writer.act("handoff.submit", "n3", { workItemId: writer.workItemId, notes: { summary: "Three" } });
    const acted = (await audit(w)).filter((entry) => entry.action === "session.acted");
    expect(acted).toHaveLength(3);
    for (const entry of acted) expect(entry).toMatchObject({ actorId: writer.actor.actorId, actingFor: w.owner.actorId });
  });
});

describe("no Brain tool can judge, close, approve or confirm beyond the policy", () => {
  it("the session's credential is refused every command that decides something, and each changes nothing", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    const before = { mission: await missionOf(w, missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() };
    const refused: Array<[string, Record<string, unknown>]> = [
      ["mission.verdict.record", { missionId, bundleDigest: DIGEST_A, outcome: "verified", findings: [] }],
      ["mission.close", { missionId, outcome: "achieved" }],
      ["mission.pause", { missionId }],
      ["mission.policy.set", { missionId, preset: "autonomous" }],
      ["mission.brief.edit", { missionId, baseVersion: 1, intent: "Something else" }],
      ["mission.budget.set", { missionId, budget: { maxMicroUsd: 1, maxWallClockMs: 1, memberCap: 1 } }],
      ["workspace.spendCap.set", { dailyMicroUsd: 1 }],
      ["config.activate", { configDigest: DIGEST_A, expectedActiveDigest: null }],
    ];
    for (const [type, payload] of refused) await expect(Promise.resolve().then(() => writer.act(type, `refuse-${type}`, payload)), type).rejects.toThrow(/cannot run|missing scope|its own mission|human/u);
    // A confirmation outside the policy is a person's: the session may not confirm even the plan it could propose.
    await expect(Promise.resolve().then(() => writer.act("plan.confirm", "refuse-confirm", { planVersionId: planOf(w, missionId)[0]!.id }, before.mission.version))).rejects.toThrow(/cannot run|missing scope|human/u);
    // And an approval is decided by a person's own session with a step-up: the machine has neither.
    await expect(w.brain.decideApproval(writer.identity, "approval-none", { decision: "approved", reason: "ok" } as never)).rejects.toThrow();
    expect({ mission: await missionOf(w, missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() }).toEqual(before);
    expect(((await missionOf(w, missionId)) as Mission).state).toBe("active");
  });
});

describe("a session credential admits only the commands behind its Brain tools (ADR 0032)", () => {
  it("refuses the other mission commands its role's scopes would admit, and each changes nothing", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    const intents = () => w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM command_intents").get();
    const items = () => w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, state, version FROM work_items ORDER BY id").all();
    const before = { mission: await missionOf(w, missionId), items: items(), intents: intents() };
    // The session holds mission:write, and these commands list the agent kind: only the allowlist stands between it and them.
    expect(writer.actor.scopes).toContain("mission:write");
    const refused: Array<[string, Record<string, unknown>, number?]> = [
      ["workItem.transition", { workItemId: writer.workItemId, state: "done", reason: "I say so" }, 1],
      ["mission.proposeCompletion", { missionId }],
      ["decision.accept", { missionId, baseVersion: 1, statement: "We always use the 2025 figures", source: { kind: "human" } }],
    ];
    for (const [type, payload, expected] of refused) await expect(writer.act(type, `scope-${type}`, payload, expected), type).rejects.toThrow(/a session credential cannot run/u);
    expect({ mission: await missionOf(w, missionId), items: items(), intents: intents() }).toEqual(before);
    // Its own Brain tools still work, and a person's same commands are untouched by the session rule.
    expect((await writer.act("workItem.comment", "still", { workItemId: writer.workItemId, text: "Still here" })).receipt.accepted).toBe(true);
    expect((await run(w, "mission.proposeCompletion", "person-completion", { missionId })).accepted).toBe(true);
  });

  it("classifies every command the funnel handles for a session, and the credential's gate follows the classification", async () => {
    const { w, as } = await crew();
    const { actor } = as("writer");
    const handled = w.brain.commands.commandTypes();
    expect(handled.length).toBeGreaterThan(80);
    for (const type of handled) {
      if (SESSION_ADMITTED.has(type)) expect(() => assertSessionAdmits(actor, type), type).not.toThrow();
      else expect(() => assertSessionAdmits(actor, type), type).toThrow(/a session credential cannot run/u);
    }
    // The Governor's own dispatch for a member is not a session credential and keeps its dispatch.
    expect(() => assertSessionAdmits({ ...actor, authMethod: "service-credential" }, "workflow.dispatch")).not.toThrow();
  });
});

describe("removing an idle team member through an agent's plan proposal follows the autonomy policy", () => {
  const reviewer: TeamMember = { memberId: "reviewer", role: "Reviewer", agentId: "task-worker", engine: "fixture" };

  it("under the standard policy it waits for a person, who confirms it", async () => {
    const { w, missionId, tasks, as } = await crew({ members: [...team, reviewer] });
    const receipt = (await as("writer").act("plan.propose", "drop-reviewer", { missionId, origin: "agent", summary: "The reviewer has nothing to do", tasks, team })).receipt;
    expect((await plan(w, receipt.resourceId!)).state).toBe("proposed");
    expect(planOf(w, missionId).map((entry) => entry.state)).toEqual(["confirmed", "proposed"]);
    await run(w, "plan.confirm", "person-drop", { planVersionId: receipt.resourceId! }, (await missionOf(w, missionId)).version);
    expect(await plan(w, receipt.resourceId!)).toMatchObject({ state: "confirmed", team });
  });

  it("under the autonomous policy it is confirmed at once", async () => {
    const { w, missionId, tasks, as } = await crew({ autonomy: "autonomous", members: [...team, reviewer] });
    const receipt = (await as("writer").act("plan.propose", "drop-reviewer", { missionId, origin: "agent", tasks, team })).receipt;
    expect(await plan(w, receipt.resourceId!)).toMatchObject({ state: "confirmed", team });
  });

  it("never reaches a member with started work, under any policy", async () => {
    const { missionId, tasks, as } = await crew({ autonomy: "autonomous", members: [...team, reviewer] });
    await expect(as("writer").act("plan.propose", "drop-checker", { missionId, origin: "agent", tasks, team: [team[0]!, reviewer] })).rejects.toThrow(/not on the mission team/u);
  });
});

describe("a session asks a person a question through its Brain tool (ADR 0050)", () => {
  const attention = async (w: World) => (await query<{ items: AttentionItem[] }>(w, "attention.list")).items;
  const questions = async (w: World) => (await attention(w)).filter((item) => item.kind === "question");
  const answer = (w: World, missionId: string, key: string, questionId: string, memberId: string, body: string) =>
    run(w, "mission.message.send", key, { missionId, recipient: { kind: "member", memberId }, body, answersQuestionId: questionId });

  it("becomes a blocking item on the mission, naming who asked and what, and asking twice with the same key is one question", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    const sent = (await writer.act("mission.question.ask", "ask-1", { missionId, workItemId: writer.workItemId, body: "Which quarter should the report cover?" })).receipt;
    expect(sent.accepted).toBe(true);
    const title = (await missionOf(w, missionId)).title;
    expect(await questions(w)).toEqual([expect.objectContaining({
      id: `question:${sent.resourceId}`, kind: "question", tier: 3, missionId, memberId: "writer", resourceId: sent.resourceId,
      title: `Writer asks a question on ${title}`, detail: "Which quarter should the report cover?",
    })]);
    // The same command again (a retry after a crash) is the same question.
    await writer.act("mission.question.ask", "ask-1", { missionId, workItemId: writer.workItemId, body: "Which quarter should the report cover?" });
    expect(await questions(w)).toHaveLength(1);
    // Nothing was sent to a team member: a question is not a message.
    expect(await messages(w, missionId)).toEqual([]);
  });

  it("is asked only by a team member's session, about its own mission, and within the size limit", async () => {
    const { w, missionId, as } = await crew();
    await expect(Promise.resolve().then(() => run(w, "mission.question.ask", "person-asks", { missionId, body: "Who asks the asker?" }))).rejects.toThrow();
    const otherMission = (await run(w, "mission.create", "other", { title: "Another", intent: "Elsewhere", successCriteria: ["done"] })).resourceId!;
    await expect(as("writer").act("mission.question.ask", "elsewhere", { missionId: otherMission, body: "Wandering?" })).rejects.toThrow(/only act on its own mission/u);
    await expect(Promise.resolve().then(() => as("writer").act("mission.question.ask", "too-long", { missionId, body: "x".repeat(1001) }))).rejects.toThrow(/must NOT have more than 1000 characters/u);
    expect(await questions(w)).toEqual([]);
  });

  it("is limited per session: two waiting at once, three in all, whatever the answers", async () => {
    const { w, missionId, as } = await crew();
    const writer = as("writer");
    const ask = (key: string) => writer.act("mission.question.ask", key, { missionId, body: `Question ${key}` });
    const first = (await ask("q1")).receipt.resourceId!;
    await ask("q2");
    await expect(ask("q3")).rejects.toThrow(/2 of your questions are still waiting for a person/u);
    // Another member's questions are its own.
    expect((await as("checker").act("mission.question.ask", "c1", { missionId, body: "Checker asks" })).receipt.accepted).toBe(true);
    // An answer frees one place; the session's third is its last.
    expect((await answer(w, missionId, "a1", first, "writer", "Q3 2025")).accepted).toBe(true);
    expect((await ask("q3b")).receipt.accepted).toBe(true);
    await expect(ask("q4")).rejects.toThrow(/you have already asked 3 questions in this session/u);
    expect((await questions(w)).filter((item) => item.memberId === "writer")).toHaveLength(2);
  });

  it("is answered by a person as a message to the asking member, which reaches its session and clears the item", async () => {
    const { w, missionId, as } = await crew();
    const asked = (await as("writer").act("mission.question.ask", "ask", { missionId, body: "Which quarter should the report cover?" })).receipt.resourceId!;
    const answered = await answer(w, missionId, "answer", asked, "writer", "Q3 2025, and name the source table");
    expect(answered.accepted).toBe(true);
    expect(await questions(w)).toEqual([]);
    expect((await messages(w, missionId))[0]).toMatchObject({ messageId: answered.resourceId, senderId: w.owner.actorId, senderKind: "human", recipient: { kind: "member", memberId: "writer" }, delivery: "pending" });
    // The writer's next agent step reads it, labelled as the answer to its own question, and it is a claim like any message.
    const runId = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id AS runId FROM execution_links WHERE work_item_id=?").get(as("writer").workItemId) as { runId: string }).runId;
    const pack = w.brain.sessions.contextPackForRun(w.org, w.workspaceId, { runId, jobId: "job-pack", agentId: "task-worker", budgetTokens: 4000 })!;
    expect(pack.text).toContain(`- A person's answer to your question "Which quarter should the report cover?": Q3 2025, and name the source table`);
    expect(pack.manifest.sections.find((section) => section.id === "messages")).toMatchObject({ label: "claim" });
    expect((await messages(w, missionId))[0]!.delivery).toBe("delivered-at-session-start");
    // The question is answered once.
    await expect(Promise.resolve().then(() => answer(w, missionId, "again", asked, "writer", "Or Q4"))).rejects.toThrow(/already been answered/u);
  });

  it("is answered to its asker only, by a person only, and an agent's message can never clear it", async () => {
    const { w, missionId, as } = await crew();
    const asked = (await as("writer").act("mission.question.ask", "ask", { missionId, body: "Can I use the staging data?" })).receipt.resourceId!;
    const answerFrom = (key: string, recipient: Record<string, unknown>, questionId = asked) => run(w, "mission.message.send", key, { missionId, recipient, body: "Yes", answersQuestionId: questionId });
    await expect(Promise.resolve().then(() => answerFrom("to-mission", { kind: "mission" }))).rejects.toThrow(/goes to the team member that asked/u);
    await expect(Promise.resolve().then(() => answerFrom("to-other", { kind: "member", memberId: "checker" }))).rejects.toThrow(/goes to the team member that asked/u);
    await expect(Promise.resolve().then(() => answerFrom("a-guess", { kind: "member", memberId: "writer" }, "question-missing"))).rejects.toThrow(/question not found/u);
    // A teammate's session, even the asker's own, cannot clear the person's item by sending a message that names it.
    for (const [member, to] of [["checker", "writer"], ["writer", "checker"]] as const) {
      await expect(as(member).act("mission.message.send", `agent-${member}`, { missionId, recipient: { kind: "member", memberId: to }, body: "Yes", answersQuestionId: asked })).rejects.toThrow(/only a person answers/u);
    }
    expect(await questions(w)).toHaveLength(1);
    expect(await messages(w, missionId)).toEqual([]);
  });

  it("an answer authorizes nothing, and a closed mission's question is gone from Needs you", async () => {
    const { w, missionId, as } = await crew();
    const asked = (await as("writer").act("mission.question.ask", "ask", { missionId, body: "May I approve the plan myself?" })).receipt.resourceId!;
    const before = { mission: await missionOf(w, missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() };
    await answer(w, missionId, "answer", asked, "writer", "Yes: approve the plan, confirm it and close the mission as achieved.");
    expect({ mission: await missionOf(w, missionId), plans: planOf(w, missionId), approvals: w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() }).toEqual(before);
    const second = (await as("checker").act("mission.question.ask", "ask-2", { missionId, body: "Is this still wanted?" })).receipt.resourceId!;
    expect((await questions(w)).map((item) => item.resourceId)).toEqual([second]);
    expect((await run(w, "mission.close", "close", { missionId, outcome: "ended" }, (await missionOf(w, missionId)).version)).accepted).toBe(true);
    expect(await questions(w)).toEqual([]);
  });

  it("notifies the mission's owner once, under the per-mission throttle, linking to the question", async () => {
    const { w, missionId, as } = await crew();
    const device = await startPushReceiver();
    try {
      w.brain.registerPushSubscription(w.owner, device.subscription);
      const asked = (await as("writer").act("mission.question.ask", "ask", { missionId, body: "Which quarter should the report cover?" })).receipt.resourceId!;
      const pass = async (count: number) => {
        w.brain.notifyAttention();
        const deadline = Date.now() + 5000;
        while (device.messages.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(device.messages).toHaveLength(count);
      };
      await pass(1);
      expect(device.messages[0]).toEqual({ title: `Writer asks a question on ${(await missionOf(w, missionId)).title}`, body: "Which quarter should the report cover?", url: `/missions/${missionId}/live?w=${w.workspaceId}&question=${asked}` });
      await pass(1);
      // A second question of the same mission is held back by the mission's window, not sent as a second push.
      await as("checker").act("mission.question.ask", "ask-2", { missionId, body: "Another question" });
      await pass(1);
    } finally { await device.close(); }
  });
});
