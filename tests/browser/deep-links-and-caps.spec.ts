import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

// Backlog row 99. (1) The plan page words the default per-task token cap instead of saying no cap exists (ADR 0022).
// (2) Unscoped deep links open the page they name; an unknown settings tab opens the Administration landing.
test("plan page shows the per-task token cap; unscoped deep links open the page they name", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Deep link organization");
  await page.getByLabel(/^Email/).fill("links@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-links", slug: "links" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const ws = { ...actor, workspaceId: "ws-links", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-links") };
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-links", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;

  // A mission with no mission-wide limit at all: the plan must still say each task has its own token cap.
  const missionId = (await command("mission.create", "l-create", { title: "Cap words", intent: "Show the cap", successCriteria: ["done"], budget: { attemptReserveTokens: 100, memberCap: 3 } })).resourceId ?? "";
  const planId = (await command("plan.propose", "l-plan", { missionId, origin: "manual", tasks: [
    { id: "a", title: "Gather sources", criteria: ["gathered"], dependsOn: [], estimatedMinutes: 10 },
    { id: "b", title: "Write the summary", criteria: ["written"], dependsOn: [] },
  ] })).resourceId ?? "";

  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-links&proposal=${planId}`);
  const estimate = page.getByTestId("plan-estimate");
  await expect(estimate).toBeVisible({ timeout: 15_000 });
  await expect(estimate.getByTestId("estimate-task-cap")).toHaveText("Each task stops at 200k tokens across all attempts; you can raise it for one task.");
  await expect(estimate).not.toContainText("No task has a cost cap");
  await expect(estimate).not.toContainText("nothing stops this plan automatically");
  await expect(estimate.getByTestId("estimate-cost")).toContainText("token cap still applies");

  // A plan with no estimate at all shows the short form: it still names the cap and no longer claims nothing limits the work.
  const bareMissionId = (await command("mission.create", "l-create-2", { title: "No estimates", intent: "Bare plan", successCriteria: ["done"], budget: { attemptReserveTokens: 100, memberCap: 3 } })).resourceId ?? "";
  const barePlanId = (await command("plan.propose", "l-plan-2", { missionId: bareMissionId, origin: "manual", tasks: [{ id: "a", title: "Do it", criteria: ["done"], dependsOn: [] }] })).resourceId ?? "";
  await page.goto(`${governor.url}/missions/${bareMissionId}/plan?w=ws-links&proposal=${barePlanId}`);
  await expect(page.getByTestId("plan-estimate").getByTestId("estimate-task-cap")).toHaveText("Each task stops at 200k tokens across all attempts; you can raise it for one task.", { timeout: 15_000 });
  await expect(page.getByTestId("plan-estimate")).not.toContainText("No spending, token or time limit is set");

  // After confirming, the mission's usage names the same cap and the mission's tokens against it.
  await command("plan.confirm", "l-confirm", { planVersionId: planId }, 1);
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-links`);
  const usage = page.getByTestId("mission-task-cap");
  await expect(usage).toBeVisible({ timeout: 15_000 });
  await expect(usage).toContainText("Each task stops at 200k tokens across all attempts; you can raise it for one task. This mission has used 0 tokens so far.");
  await expect(page.getByTestId("mission-usage")).not.toContainText("No token ceiling is set");

  // Unscoped deep links open the page they name in the current workspace.
  const heading = (name: string) => page.getByRole("heading", { name, exact: true, level: 1 });
  await page.goto(`${governor.url}/library`);
  await expect(heading("Library")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/w\/ws-links\/library$/);
  await page.goto(`${governor.url}/missions`);
  await expect(page).toHaveURL(/\/w\/ws-links\/missions$/, { timeout: 15_000 });

  // Quality and Health live under Administration.
  await page.goto(`${governor.url}/settings?tab=quality`);
  await expect(heading("Quality")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/quality$/);
  await page.goto(`${governor.url}/settings?tab=health`);
  await expect(heading("Health")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/settings\?tab=health$/);

  // An unknown tab opens the Administration landing, not another page's content under the wrong name.
  await page.goto(`${governor.url}/settings?tab=nonsense`);
  await expect(heading("Setup")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/settings\?tab=setup$/);
  expect(errors).toEqual([]);
});
