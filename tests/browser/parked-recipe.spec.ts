import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";

/** A parked task whose agent cannot reach what it needs can be run with another recipe: the UI offers the active release's recipes and revises the plan. */
test("a parked task can be moved to another recipe, as a new plan version", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Recipe organization");
  await page.getByLabel(/^Email/).fill("recipe@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-recipe", slug: "recipe" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-recipe")).actor;
  const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-recipe", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await run("mission.create", "recipe-mission", { title: "Inspect the containers", intent: "Look at the running containers", successCriteria: ["listed"] })).resourceId!;
  const planId = (await run("plan.propose", "recipe-plan", { missionId, origin: "manual", tasks: [{ id: "inspect", title: "Inspect running containers", criteria: ["The containers are listed"], dependsOn: [] }] })).resourceId!;
  const version = () => (brain.store.workspaceDb("ws-recipe", scoped.organizationId).prepare("SELECT version FROM missions WHERE id=?").get(missionId) as { version: number }).version;
  await run("plan.confirm", "recipe-confirm", { planVersionId: planId }, version());
  const ws = brain.store.workspaceDb("ws-recipe", scoped.organizationId);
  ws.prepare("UPDATE work_items SET state='blocked', parked=1, failed_attempts=3, parked_diagnostic='the agent could not reach the containers', blocked_reason='Parked after 3 failed attempts' WHERE plan_task_id='inspect'").run();

  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-recipe`);
  await page.getByRole("button", { name: "Manage Inspect running containers" }).click();
  const parked = page.getByRole("region", { name: "Parked work item" });
  await expect(parked.getByText("Parked after repeated failures", { exact: true })).toBeVisible();
  await parked.getByLabel("Run this task with").click();
  await page.getByRole("option", { name: "Investigate the demos server" }).click();
  await parked.getByRole("button", { name: "Run with this", exact: true }).click();
  // The plan was revised and confirmed with the task's recipe changed; the task now runs with it.
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id=? AND state='confirmed' AND tasks_json LIKE '%sre-task%'").get(missionId) as { n: number }).n).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
