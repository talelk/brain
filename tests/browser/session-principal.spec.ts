import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollRunners, signUpOwner } from "../support/flow";

/**
 * ADR 0032 as the owner sees it: a team member's session works on its own machine principal, acting for the owner, and Health's
 * "Recent activity" says so instead of putting the machine's change under the owner's name. The mission, the runner and the session's
 * command go through the Governor's own commands and runner protocol; what the first-time owner reads is the real page.
 */
test("Health shows what an agent session did as the agent, working for the owner", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const { brain, actor: owner, cookie } = await signUpOwner(page, governor, "principal");
  brain.createWorkspace(owner, { workspaceId: "ws-principal", slug: "principal" });
  const bundle = fixtureStarter();
  brain.activateRelease(owner, brain.stageRelease(owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-principal")).actor;
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-principal", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await command("mission.create", "create", { title: "Tidy the docs", intent: "Fix the broken links", successCriteria: ["links work"] })).resourceId!;
  const planId = (await command("plan.propose", "plan", { missionId, origin: "manual", tasks: [{ id: "links", title: "Fix the links", criteria: ["links work"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId!;
  const version = (brain.store.workspaceDb("ws-principal", owner.organizationId).prepare("SELECT version FROM missions WHERE id=?").get(missionId) as { version: number }).version;
  await command("plan.confirm", "confirm", { planVersionId: planId }, version);

  // A runner takes the task; its running attempt acts as the member's machine principal.
  const [agents] = await enrollRunners(governor, owner, "principal", ["agents"]);
  const runner = brain.jobProtocol.authenticate(new Headers({ authorization: `Bearer ${agents!.sessionToken}` }));
  const offer = brain.jobProtocol.claim(runner, "claim-principal") as unknown as { attemptId: string; leaseId: string; jobFence: number };
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: `sha256:${"a".repeat(64)}`, features: ["sessions"] } });
  const { credential } = brain.jobProtocol.sessionCredential(runner, offer.attemptId);
  const session = await brain.resolveActor(new Headers({ authorization: `Bearer ${credential}` }), "ws-principal");
  const workItemId = (brain.store.workspaceDb("ws-principal", owner.organizationId).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
  await brain.executeCommand(session.actor, { contractVersion: "brain.command/v1", commandId: "cmd-session-comment", commandType: "workItem.comment", workspaceId: "ws-principal", idempotencyKey: "session-comment", payload: { workItemId, text: "Two links were wrong" } } as never, "session-comment");

  await page.goto(`${governor.url}/w/ws-principal/missions`);
  await page.goto(`${governor.url}/settings?tab=health`);
  await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();
  const activity = page.getByRole("region", { name: "Recent activity" });
  await expect(activity.getByText('A comment was added to task "Fix the links"', { exact: true })).toBeVisible();
  // Who did it and through which session, in one plain sentence per entry: the agent for the owner, never the owner.
  await expect(activity.getByText("By an agent working for you, through its session", { exact: true })).toBeVisible();
  await expect(activity.getByText("By an agent working for you, through its session", { exact: true })).toHaveCount(1);
  // The dispatch of the member's task is the member's principal too, never the owner's own name.
  await expect(activity.getByText("By an agent working for you", { exact: true })).toHaveCount(1);
  await expect(activity.getByText("By you", { exact: true })).toHaveCount(0);

  // The Logs explorer says the same for the same event: open the session's comment and read who caused it.
  await page.goto(`${governor.url}/w/ws-principal/logs`);
  await page.getByRole("button", { name: /added a comment to a task/ }).first().click();
  await expect(page.getByTestId("log-actor")).toHaveText("By an agent working for you, through its session");
});
