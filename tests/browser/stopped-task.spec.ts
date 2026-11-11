import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { ActorContext, Mission } from "@brain/contracts";
import { signUpOwner } from "../support/flow";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * Track U: a task whose agent was interrupted too often is never shown as running. It is stopped, says so in
 * plain words on the mission and on Today (Needs you), and one click, Try again, puts it back to work.
 */
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("a task stopped by repeated interruptions shows Stopped, appears in Needs you and Try again restarts it", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor } = await signUpOwner(page, governor, "stopped");
  brain.createWorkspace(actor, { workspaceId: "ws-stopped", slug: "stopped" });
  const ws: ActorContext = { ...actor, workspaceId: "ws-stopped", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-stopped") };
  const db = brain.store.workspaceDb("ws-stopped", actor.organizationId);
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-stopped", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const mission = async (id: string): Promise<Mission> => ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-stopped", resourceId: id })) as unknown as { snapshot: Mission }).snapshot;
  const missionId = (await cmd("mission.create", "stopped-create", { title: "Compare note-taking tools", intent: "Compare the candidate tools", successCriteria: ["done"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "stopped-plan", { missionId, origin: "manual", summary: "Plan", tasks: [{ id: "t", title: "Compile the candidate note-taking tools", criteria: ["A list exists"], dependsOn: [] }] })).resourceId ?? "";
  await cmd("plan.confirm", "stopped-confirm", { planVersionId: planId }, (await mission(missionId)).version);
  const item = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
  db.prepare("UPDATE work_items SET state='blocked', parked=1, parked_diagnostic='The agent was interrupted 7 times; try again.', blocked_reason='Stopped: waiting for you to try again', next_action='A person tries again, reassigns, edits or drops this work' WHERE id=?").run(item.id);

  // Today: Needs you names it and offers Try again.
  await page.goto(`${governor.url}/w/ws-stopped/today`);
  const row = page.getByTestId("needs-you").getByTestId("needs-you-item").filter({ hasText: "stopped: waiting for you to try again" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("The agent was interrupted 7 times; try again.");
  await expect(row.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await shot(page, "stopped-today");

  // The mission never says the task is running.
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-stopped`);
  await expect(page).toHaveURL(/\/missions\/[^/]+\/plan/);
  await expect(page.getByRole("heading", { name: "Compare note-taking tools" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/stopped: waiting for you to try again/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/task is running|tasks are running/)).toHaveCount(0);
  await shot(page, "stopped-mission");

  // One click puts it back to work.
  await page.goto(`${governor.url}/w/ws-stopped/today`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  expect((db.prepare("SELECT parked FROM work_items WHERE id=?").get(item.id) as { parked: number }).parked).toBe(0);
  expect(errors).toEqual([]);
});
