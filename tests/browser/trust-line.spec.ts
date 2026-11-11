import { test, expect } from "./fixtures";
import { modelOpinionStarter } from "../support/starter";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";

/**
 * The trust line (#49), end to end on the fixture engine with real runners: a
 * task whose only support is a model's opinion shows as Unverified and stays in
 * Verifying (never auto-completes); the person's Accept is the sign-off, after
 * which the line says "by human sign-off" and the task is Done.
 */
test("a model-only criterion keeps the task in Verifying until a person signs off", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const shots = process.env["TODAY_SHOTS"] ?? "";
  const { brain, actor, cookie } = await signUpOwner(page, governor, "trust");
  brain.createWorkspace(actor, { workspaceId: "ws-trust", slug: "trust" });
  const starter = modelOpinionStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-trust")).actor;
  const sessions = await enrollRunners(governor, actor, "trust");
  const ws = brain.store.workspaceDb("ws-trust", actor.organizationId);

  await page.goto(`${governor.url}/w/ws-trust/missions/new`);
  await page.getByRole("dialog").getByLabel(/^What do you want done/).fill("Compare two venues for the offsite");
  await page.getByRole("dialog").getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (ws.prepare("SELECT id FROM missions").get() as { id: string }).id;
  const key = "trust-plan";
  const { receipt } = await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-trust", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary: "One task", tasks: [{ id: "inspect", title: "Compare the venues", criteria: ["structure", "safety"], dependsOn: [], workflowId: "x" }] },
  } as never, key);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();

  const state = () => (ws.prepare("SELECT state FROM work_items WHERE mission_id=? AND plan_task_id='inspect'").get(missionId) as { state: string }).state;
  await expect.poll(state).toBe("in-progress");
  await driveRuns(sessions, () => state() === "review");
  // The run finished and a verdict passed, but only a model's opinion supports it: it never reaches Done by itself.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(state()).toBe("review");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs`);
  const card = page.getByTestId("mission-result").filter({ hasText: "Compare the venues" });
  await expect(card.getByText("Unverified", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  if ((await card.getAttribute("data-open")) !== "true") await card.getByRole("button", { name: /Compare the venues/ }).click();
  const reader = card.getByTestId("result-reader");
  await expect(reader.getByTestId("trust-line")).toContainText("Unverified. 0 of 4 criteria checked by tests, files or hashes; 0 by human sign-off; 4 by model opinion");
  await reader.getByText("How this was checked").click();
  await expect(reader.getByTestId("how-checked").locator('[data-basis="model"]')).toHaveCount(4);
  await expect(card.getByTestId("needs-sign-off")).toContainText("stays in Verifying until a person signs off");
  if (shots) await page.screenshot({ path: `${shots}/trust-unverified-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (shots) await page.screenshot({ path: `${shots}/trust-unverified-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await card.getByRole("button", { name: "Sign off and accept" }).click();
  await expect.poll(state).toBe("done");
  await expect(page.getByText("Work is waiting for your review")).toHaveCount(0, { timeout: 15_000 });
  await expect(reader.getByTestId("trust-line")).toContainText("0 of 4 criteria checked by tests, files or hashes; 4 by human sign-off; 0 by model opinion", { timeout: 30_000 });
  await expect(reader.getByTestId("how-checked").locator('[data-basis="human"]')).toHaveCount(4);
  if (shots) await page.screenshot({ path: `${shots}/trust-signed-1440.png`, fullPage: true });
});
