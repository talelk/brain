import { test, expect } from "./fixtures";
import { dispatchActor } from "../../apps/governor/src/modules/identity/index";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

/**
 * Issue #107: a team member's session may message another member through its Brain tool. A first-time user opens the mission's Live tab and
 * reads who said what: their own message under "you", the member's under its role, never under a raw machine id.
 */
test("a message from a team member shows on the mission's Live tab under its role, beside the person's own (#107)", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor } = await signUpOwner(page, governor, "messages");
  brain.createWorkspace(actor, { workspaceId: "ws-messages", slug: "messages" });
  const owner = (await brain.resolveActor(new Headers({ cookie: (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ") }), "ws-messages")).actor;
  const bundle = fixtureStarter();
  brain.activateRelease(owner, brain.stageRelease(owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const run = async (by: typeof owner, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const { receipt } = await brain.executeCommand(by, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-messages", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    expect(receipt.accepted).toBe(true);
    return receipt.resourceId ?? "";
  };
  const missionId = await run(owner, "mission.create", "mission", { title: "Write the release notes", intent: "Release notes for the next version", successCriteria: ["The notes are written"] });
  const planId = await run(owner, "plan.propose", "plan", {
    missionId, origin: "manual",
    team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }, { memberId: "checker", role: "Fact checker", agentId: "task-worker", engine: "fixture" }],
    tasks: [
      { id: "draft", title: "Draft the notes", criteria: ["A draft exists"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } },
      { id: "check", title: "Check the facts", criteria: ["The facts are checked"], dependsOn: ["draft"], assignment: { kind: "agent", id: "checker", role: "reviewer" } },
    ],
  });
  await run(owner, "plan.confirm", "confirm", { planVersionId: planId }, 1);
  // The writer's session (its own machine principal, acting for the owner) tells the checker something, as its Brain tool does.
  const writer = dispatchActor(brain.store, { organizationId: owner.organizationId, workspaceId: "ws-messages", missionId, memberId: "writer", actingFor: owner.actorId });
  await run(writer, "mission.message.send", "from-writer", { missionId, recipient: { kind: "member", memberId: "checker" }, body: "The 2025 figures are in the shared table" });

  // The first-time user opens the Live tab and finds the message, named for the member who wrote it.
  await page.goto(`${governor.url}/missions/${missionId}/live?w=ws-messages`);
  await expect(page.getByRole("heading", { name: "Write the release notes", level: 1 })).toBeVisible();
  const messages = page.locator("section", { has: page.getByRole("heading", { name: "Messages", exact: true }) });
  const fromWriter = messages.getByRole("listitem").filter({ hasText: "The 2025 figures are in the shared table" });
  await expect(fromWriter).toHaveCount(1);
  await expect(fromWriter.locator("[data-message-sender]")).toHaveText("Writer (team member)");
  await expect(fromWriter).toContainText("to Fact checker");
  await expect(fromWriter).toContainText("pending");

  // They answer the mission with a message of their own: it is theirs, under "you", and the member's stays as it was.
  await page.getByRole("button", { name: "Message the mission", exact: true }).click();
  await page.getByRole("textbox", { name: /^Message/ }).fill("Thanks, please keep to those figures");
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click();
  const mine = messages.getByRole("listitem").filter({ hasText: "Thanks, please keep to those figures" });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator("[data-message-sender]")).toHaveText("you");
  await expect(fromWriter.locator("[data-message-sender]")).toHaveText("Writer (team member)");

  // A message never authorizes anything: the mission and its plan are as they were.
  const mission = ((await brain.executeQuery(owner, { queryType: "missions.get", workspaceId: "ws-messages", resourceId: missionId })) as unknown as { snapshot: { state: string; activePlanVersionId: string } }).snapshot;
  expect([mission.state, mission.activePlanVersionId]).toEqual(["active", planId]);
  expect(await page.locator("body").innerText()).not.toMatch(/agent:[a-z0-9-]+:writer/u);
  expect(errors).toEqual([]);
});
