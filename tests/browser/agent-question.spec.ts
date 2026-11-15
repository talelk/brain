import { test, expect } from "./fixtures";
import type { AttentionItem, MissionMessage } from "@brain/contracts";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

/**
 * Issue #109: a team member's session asks a person a question through its Brain tool, and the person answers from the mission's composer.
 * The writer's task asks two questions (its criteria call the tool, which the fixture engine makes through the real runner, credential and
 * Governor). A first-time user then finds them in Needs you and on the mission's Live tab, answers one from each, and sees each item go.
 */
test("a team member's question reaches Needs you and the mission, and the person's answer goes to that member (#109)", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "question");
  brain.createWorkspace(actor, { workspaceId: "ws-question", slug: "question" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const owner = (await brain.resolveActor(new Headers({ cookie }), "ws-question")).actor;
  const [agents] = await enrollRunners(governor, actor, "question", ["agents"]);
  const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const { receipt } = await brain.executeCommand(owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-question", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    expect(receipt.accepted).toBe(true);
    return receipt.resourceId ?? "";
  };
  const ask = (question: string) => `FIXTURE_CALL_TOOL ${JSON.stringify({ id: "mission.ask", input: { question } })}`;
  const missionId = await run("mission.create", "mission", { title: "Compile the quarterly report", intent: "Compile the quarterly report", successCriteria: ["The report is complete"] });
  const planId = await run("plan.propose", "plan", {
    missionId, origin: "manual",
    team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }, { memberId: "checker", role: "Fact checker", agentId: "task-worker", engine: "fixture" }],
    tasks: [
      { id: "draft", title: "Draft the report", criteria: [ask("Which quarter should the report cover?"), ask("May I cite the staging figures?"), "A draft exists"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } },
      { id: "check", title: "Check the figures", criteria: ["The figures are checked"], dependsOn: ["draft"], assignment: { kind: "agent", id: "checker", role: "reviewer" } },
    ],
  });
  await run("plan.confirm", "confirm", { planVersionId: planId }, 1);
  const db = brain.store.workspaceDb("ws-question", actor.organizationId);
  const asked = () => (db.prepare("SELECT COUNT(*) AS n FROM mission_questions").get() as { n: number }).n;
  await driveRuns([agents!], () => asked() >= 2);
  const attention = async () => ((await brain.executeQuery(owner, { queryType: "attention.list", workspaceId: "ws-question" })) as unknown as { snapshot: { items: AttentionItem[] } }).snapshot.items.filter((item) => item.kind === "question");
  expect(await attention()).toHaveLength(2);

  // The first-time user opens Today and finds both questions in Needs you, each naming who asked and what.
  await page.goto(`${governor.url}/w/ws-question/today`);
  const queue = page.getByTestId("needs-you");
  const rows = queue.locator('[data-kind="question"]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const first = rows.filter({ hasText: "Which quarter should the report cover?" });
  await expect(first).toContainText("Writer asks a question on Compile the quarterly report");
  await expect(first.getByRole("button", { name: "Answer", exact: true })).toBeVisible();

  // Answer one from Needs you: it opens the mission with the composer on that question, aimed at the member that asked.
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Answer a question" });
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId("answering-question")).toContainText("Which quarter should the report cover?");
  await expect(composer).toContainText("To: Writer");
  await expect(composer.getByRole("checkbox")).toHaveCount(0);
  await composer.getByRole("textbox", { name: /^Your answer/ }).fill("Q3 2025, and cite the source table");
  await composer.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(composer).toHaveCount(0);

  // The answered question left the mission; the other one is still there, on the Live tab the person is looking at.
  const open = page.getByTestId("mission-question");
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("May I cite the staging figures?");
  const messages = page.locator("section", { has: page.getByRole("heading", { name: "Messages", exact: true }) });
  const sent = messages.getByRole("listitem").filter({ hasText: "Q3 2025, and cite the source table" });
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText("to Writer");
  await expect(sent.locator("[data-message-sender]")).toHaveText("you");

  // Answer the other from the mission itself.
  await open.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: /^Your answer/ }).fill("No: use the audited figures only");
  await composer.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.getByTestId("mission-question")).toHaveCount(0);
  await expect(messages.getByRole("listitem").filter({ hasText: "No: use the audited figures only" })).toHaveCount(1);

  // Nothing waits any more: Needs you has no question and the Governor holds no open one.
  await page.goto(`${governor.url}/w/ws-question/today`);
  await expect(page.getByTestId("needs-you-item").filter({ hasText: "asks a question" })).toHaveCount(0);
  expect(await attention()).toEqual([]);

  // The answers are messages from the person to the member that asked, read as answers to its own questions; they approve nothing.
  const delivered = ((await brain.executeQuery(owner, { queryType: "missionMessages.list", workspaceId: "ws-question", resourceId: missionId })) as unknown as { snapshot: { items: MissionMessage[] } }).snapshot.items;
  expect(delivered.map((message) => `${message.body} | ${message.senderKind} | ${message.recipient.memberId}`).sort()).toEqual([
    "No: use the audited figures only | human | writer", "Q3 2025, and cite the source table | human | writer",
  ]);
  const runId = (db.prepare("SELECT l.run_id AS runId FROM execution_links l JOIN work_items i ON i.id=l.work_item_id WHERE i.mission_id=? AND i.plan_task_id='draft'").get(missionId) as { runId: string }).runId;
  const pack = brain.sessions.contextPackForRun(actor.organizationId, "ws-question", { runId, jobId: "job-pack", agentId: "task-worker", budgetTokens: 4000 })!;
  expect(pack.text).toContain(`A person's answer to your question "Which quarter should the report cover?": Q3 2025, and cite the source table`);
  expect(pack.text).toContain(`A person's answer to your question "May I cite the staging figures?": No: use the audited figures only`);
  const mission = ((await brain.executeQuery(owner, { queryType: "missions.get", workspaceId: "ws-question", resourceId: missionId })) as unknown as { snapshot: { state: string; activePlanVersionId: string } }).snapshot;
  expect([mission.state, mission.activePlanVersionId]).toEqual(["active", planId]);
  expect(await page.locator("body").innerText()).not.toMatch(/agent:[a-z0-9-]+:writer/u);
  expect(errors).toEqual([]);
});
