import type { Page } from "@playwright/test";
import type { ActorContext, BrainSession } from "@brain/contracts";
import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { delegatingStarter } from "../support/starter";
import { delegateFrom, delegationsOf, driveChildren, enrollChildRunners, registerRunner, sessionIdentity, startAttempt } from "../support/delegation-world";
import type { Brain } from "../../apps/governor/src/application/brain";

/**
 * Delegated work, walked as a first-time user would (ADR 0051, spec #90 stories 36 to 38). A running session of a mission hands three
 * sub-tasks to child sessions: one the fixture runners finish and an independent check verifies, one that fails, and one a person started
 * themselves. The person opens the mission, finds the delegated work from the task and from the tab, reads what each child handed back,
 * accepts one result and is told why they cannot decide the one they started.
 */

const WS = "ws-del";

async function world(page: Page, governor: { url: string; credential: string; app: { brain: Brain } }) {
  const { brain, actor, cookie } = await signUpOwner(page, governor, "delegation");
  brain.createWorkspace(actor, { workspaceId: WS, slug: "delegation" });
  const bundle = delegatingStarter({ maxChildren: 4, maxDepth: 3 });
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped: ActorContext = (await brain.resolveActor(new Headers({ cookie }), WS)).actor;
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => {
    const { receipt } = await brain.executeCommand(scoped, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: WS, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    expect(receipt.accepted, JSON.stringify(receipt)).toBe(true);
    return receipt;
  };
  return { brain, actor: scoped, command, ws: brain.store.workspaceDb(WS, actor.organizationId) };
}

test("a reviewer finds delegated work from the task and the mission, reads each result and decides the one they may", async ({ page, governor }) => {
  test.setTimeout(2120_000);
  const { brain, actor, command, ws } = await world(page, governor);

  // A mission with one task for the member "pi"; its session is the running attempt of the first job.
  const missionId = (await command("mission.create", "mission", { title: "Choose a supplier", intent: "Pick the cheaper supplier", successCriteria: ["A supplier is chosen"] })).resourceId!;
  const planId = (await command("plan.propose", "plan", { missionId, origin: "manual", tasks: [{ id: "compare", title: "Compare vendor prices", criteria: ["Prices are compared"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId!;
  const version = (ws.prepare("SELECT version FROM missions WHERE id=?").get(missionId) as { version: number }).version;
  await command("plan.confirm", "confirm", { planVersionId: planId }, version);
  const manual = registerRunner(brain, actor, "runner-parent");
  const parent = startAttempt(brain, manual, "parent");
  const session = await sessionIdentity(brain, manual, parent, WS);
  const parentSession = ((await brain.executeQuery(actor, { queryType: "sessions.list", workspaceId: WS } as never)) as unknown as { snapshot: { items: BrainSession[] } }).snapshot.items.find((entry) => entry.attemptId === parent.attemptId)!;

  // The session asks for three children through its own credential, as its Brain tool does; a person asks for a fourth, naming the session.
  const checked = (await delegateFrom(brain, session, WS, "d-check", { missionId, task: "Summarise the three cheapest vendors" })).resourceId!;
  const broken = (await delegateFrom(brain, session, WS, "d-broken", { missionId, task: "Read the supplier register" })).resourceId!;
  await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: "cmd-d-mine", commandType: "session.delegate", workspaceId: WS, idempotencyKey: "d-mine", payload: { parentSessionId: parentSession.sessionId, task: "Draft the supplier shortlist" } } as never, "d-mine");
  const byId = async (id: string) => (await delegationsOf(brain, actor, WS, missionId)).find((entry) => entry.delegationId === id)!;
  // The register cannot be read: that child's run fails before any runner takes it.
  brain.workflows.completeStep(actor.organizationId, WS, (await byId(broken)).run.runId!, "respond", { error: "The supplier register could not be reached" }, false);

  // Runners take the other two children's jobs and their independent checks.
  const runners = await enrollChildRunners(brain, actor, governor.url, "delegation");
  await driveChildren(brain, runners, () => (ws.prepare("SELECT COUNT(*) AS n FROM delegation_runs WHERE state='succeeded'").get() as { n: number }).n === 2, 120_000);
  expect((await byId(checked)).run.state).toBe("succeeded");

  // First-time user: open the mission from the list.
  await page.goto(`${governor.url}/w/${WS}/missions`);
  await page.getByRole("button", { name: "Open mission Choose a supplier", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\//);

  // The task shows what it delegated, with a way to the review.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan?w=${WS}`);
  await page.getByRole("button", { name: "Manage Compare vendor prices", exact: true }).click();
  const panel = page.locator("[data-work-item-delegations]");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Summarise the three cheapest vendors", { exact: true })).toBeVisible();
  await expect(panel.getByText("Waiting for review", { exact: true })).toHaveCount(2);
  await expect(panel.getByText("Failed", { exact: true })).toBeVisible();
  await panel.getByRole("link", { name: "Review 1 delegated result", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/delegations\?w=ws-del&item=/);

  // The screen: every child, what it handed back or why it failed, and what the person may decide.
  const screen = page.locator("[data-delegations]");
  await expect(screen.getByText("1 result is waiting for your review.", { exact: true })).toBeVisible();
  const done = screen.getByRole("article", { name: "Summarise the three cheapest vendors" });
  await expect(done.getByText("Waiting for review", { exact: true })).toBeVisible();
  await expect(done.locator("[data-delegation-result]")).toContainText("Fixture result for: Summarise the three cheapest vendors");
  await expect(done.locator("[data-delegation-evidence]")).toContainText("An independent check verified it.");
  const failed = screen.getByRole("article", { name: "Read the supplier register" });
  await expect(failed.locator("[data-delegation-failure]")).toContainText("The supplier register could not be reached");
  await expect(failed.getByRole("button", { name: "Accept result", exact: true })).toHaveCount(0);
  // A person who started a delegation does not review it, and is told why.
  const own = screen.getByRole("article", { name: "Draft the supplier shortlist" });
  await expect(own.locator("[data-delegation-cannot]")).toHaveText("You started this delegation, so another person has to review it.");
  await expect(own.getByRole("button", { name: "Accept result", exact: true })).toHaveCount(0);

  // Accepting the checked result records who decided and when.
  await done.getByRole("button", { name: "Accept result", exact: true }).click();
  await expect(done.getByText("Accepted", { exact: true }).first()).toBeVisible();
  await expect(done.locator("[data-delegation-decided]")).toContainText("Accepted by you");
  await expect(done.getByRole("button", { name: "Accept result", exact: true })).toHaveCount(0);
  expect((await byId(checked)).state).toBe("accepted");
  expect((await byId(checked)).reviewerId).toBe(actor.actorId);
  await expect(screen.getByText("No delegated result is waiting for review.", { exact: true })).toBeVisible();

  // The mission's own tab carries the same screen without the task filter.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/live?w=${WS}`);
  await page.getByRole("radio", { name: "Delegated work", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/delegations/);
  await expect(page.locator("[data-delegations] article")).toHaveCount(3);
});
