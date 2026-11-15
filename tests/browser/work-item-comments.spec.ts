import { test, expect } from "./fixtures";
import type { MissionMessage } from "@brain/contracts";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";

/**
 * Issue #100: a first-time user opens a task on the mission's plan, reads its (empty) comment thread, comments, corrects the comment,
 * and sees that the note went to the team member serving the task. A comment never approves or moves anything.
 */
test("a person comments on a task, corrects the comment and sees it reach the team member (#100)", async ({ page, governor }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor } = await signUpOwner(page, governor, "comments");
  brain.createWorkspace(actor, { workspaceId: "ws-comments", slug: "comments" });
  const owner = (await brain.resolveActor(new Headers({ cookie: (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ") }), "ws-comments")).actor;
  const bundle = fixtureStarter();
  brain.activateRelease(owner, brain.stageRelease(owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const { receipt } = await brain.executeCommand(owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-comments", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    expect(receipt.accepted).toBe(true);
    return receipt.resourceId ?? "";
  };
  const missionId = await run("mission.create", "mission", { title: "Write the release notes", intent: "Release notes for the next version", successCriteria: ["The notes are written"] });
  const planId = await run("plan.propose", "plan", {
    missionId, origin: "manual", team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }],
    tasks: [{ id: "draft", title: "Draft the notes", criteria: ["A draft exists"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } }],
  });
  await run("plan.confirm", "confirm", { planVersionId: planId }, 1);
  const workItems = async () => ((await brain.executeQuery(owner, { queryType: "workItems.list", workspaceId: "ws-comments", limit: 100 })) as unknown as { snapshot: { items: Array<{ workItemId: string; state: string; version: number }> } }).snapshot.items;
  const before = (await workItems())[0]!;
  const messages = async () => ((await brain.executeQuery(owner, { queryType: "missionMessages.list", workspaceId: "ws-comments", resourceId: missionId })) as unknown as { snapshot: { items: MissionMessage[] } }).snapshot.items;

  // The first-time user finds the task on the mission's Plan tab and opens it.
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-comments`);
  await expect(page.getByRole("heading", { name: "Write the release notes", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Manage Draft the notes" }).click();
  await expect(page.getByRole("heading", { name: "Comments", level: 4 })).toBeVisible();
  await expect(page.getByText("No comments yet")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("item")).toBe(before.workItemId);

  // Comment: it is on the thread under their name and says where it is going.
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("dialog").getByLabel(/^Comment/).fill("Mention the new export button");
  await page.getByRole("dialog").getByRole("button", { name: "Add comment", exact: true }).click();
  const thread = page.getByRole("list", { name: "Comments" });
  await expect(thread.getByRole("listitem")).toHaveCount(1);
  await expect(thread).toContainText("Mention the new export button");
  await expect(thread).toContainText("you");
  await expect(thread).toContainText("Will reach writer when its next session starts");

  // Correct it: the correction sits beside the original, which says it was corrected and that nobody received it.
  await thread.getByRole("button", { name: "Correct this comment" }).click();
  await page.getByRole("dialog").getByLabel(/^Comment/).fill("Mention the new export button and where to find it");
  await page.getByRole("dialog").getByRole("button", { name: "Save the correction" }).click();
  await expect(thread.getByRole("listitem")).toHaveCount(2);
  await expect(thread.getByRole("listitem").first()).toContainText("Corrected below");
  await expect(thread.getByRole("listitem").first()).toContainText("Replaced by a correction before anyone received it");
  await expect(thread.getByRole("listitem").nth(1)).toContainText("Corrects an earlier comment");
  await expect(thread.getByRole("listitem").nth(1)).toContainText("Mention the new export button and where to find it");
  // Only the latest comment can be corrected.
  await expect(thread.getByRole("button", { name: "Correct this comment" })).toHaveCount(1);

  // The team member's message is the corrected text alone, still waiting for its next session; nothing else moved.
  expect((await messages()).map((entry) => [entry.body, entry.delivery, entry.recipient.memberId])).toEqual([["Mention the new export button and where to find it", "pending", "writer"], ["Mention the new export button", "superseded", "writer"]]);
  const after = (await workItems())[0]!;
  expect([after.state, after.version]).toEqual([before.state, before.version]);

  // The task stays open across a reload, and so does its thread.
  await page.reload();
  await expect(page.getByRole("list", { name: "Comments" }).getByRole("listitem")).toHaveCount(2);
  expect(errors).toEqual([]);
});
