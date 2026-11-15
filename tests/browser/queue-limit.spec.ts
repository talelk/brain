import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollRunners, signUpOwner } from "../support/flow";

/**
 * Story 98 (ADR 0040): an administrator sets how many tasks may wait for a runner, under "How work runs". When the queue is at the limit a
 * person who starts work on Today or on New mission is refused in words, on the page where they started, and nothing is created; raising
 * the limit lets the same sentence start a mission. Runners are enrolled but never drive a run, so queued work stays queued.
 */
test("a full queue refuses a new mission on Today and New mission with the reason, until an administrator raises the limit", async ({ page, governor }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "queue");
  brain.createWorkspace(actor, { workspaceId: "ws-queue", slug: "queue" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  await enrollRunners(governor, actor, "queue", ["agents", "evaluators"]);
  const missionCount = () => (brain.store.workspaceDb("ws-queue", actor.organizationId).prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n;

  // The administrator finds the section, sees the default, and lowers the limit to one waiting task.
  await page.goto(`${governor.url}/w/ws-queue/today`);
  await expect(page.getByLabel(/^What do you want done/)).toBeEnabled({ timeout: 30_000 });
  await page.goto(`${governor.url}/settings?tab=work`);
  const queue = page.locator("[data-work-queue]");
  await expect(queue).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Queue limit", exact: true })).toBeVisible();
  await expect(page.locator("[data-work-queue-current]")).toHaveText("0 waiting now, limit 100. This is the default.");
  await queue.getByLabel("Most tasks waiting", { exact: true }).fill("0");
  await expect(queue.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await queue.getByLabel("Most tasks waiting", { exact: true }).fill("1");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(queue.getByRole("status")).toHaveText("The queue limit was saved.");
  await expect(page.locator("[data-work-queue-current]")).toHaveText("0 waiting now, limit 1.", { timeout: 30_000 });

  // One person's confirmed plan puts a task in the queue (no runner works yet), which fills it.
  const member = (await brain.resolveActor(new Headers({ cookie }), "ws-queue")).actor;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(member, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-queue", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await cmd("mission.create", "queue-first", { title: "Compare two venues", intent: "Compare two venues", successCriteria: ["Both venues are compared"] })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "queue-first-plan", { missionId, origin: "manual", tasks: [{ id: "compare", title: "Compare the venues", criteria: ["Both venues are compared"], dependsOn: [] }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(member, { queryType: "missions.get", workspaceId: "ws-queue", resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await cmd("plan.confirm", "queue-first-confirm", { planVersionId: planId }, version);
  await expect.poll(() => (brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id='ws-queue' AND state='queued'").get() as { n: number }).n, { timeout: 30_000 }).toBe(1);
  await page.reload();
  await expect(page.locator("[data-work-queue-current]")).toHaveText("1 waiting now, limit 1.", { timeout: 30_000 });
  await expect(page.locator("[data-work-queue]")).toHaveAttribute("data-work-queue", "full");
  const missionsBefore = missionCount();

  // Today: the sentence is refused where it was typed, with the numbers and who can raise the limit; nothing was created.
  await page.goto(`${governor.url}/w/ws-queue/today`);
  await page.getByLabel(/^What do you want done/).fill("Draft the offsite agenda");
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  const refusal = page.getByRole("alert").filter({ hasText: "queue limit" });
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText("This workspace already has 1 task waiting for a runner, which is its queue limit (1).");
  await expect(refusal).toContainText("ask an administrator to raise the queue limit under Administration, How work runs.");
  await expect(page).toHaveURL(/\/w\/ws-queue\/today/);
  expect(missionCount()).toBe(missionsBefore);

  // New mission says the same thing under its own title and keeps what was typed.
  await page.goto(`${governor.url}/w/ws-queue/missions/new`);
  await page.getByLabel(/^What do you want done/).fill("Draft the offsite agenda");
  await page.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page.getByText("The mission was not started")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This workspace already has 1 task waiting for a runner")).toBeVisible();
  await expect(page.getByLabel(/^What do you want done/)).toHaveValue("Draft the offsite agenda");
  expect(missionCount()).toBe(missionsBefore);

  // The administrator raises the limit; the same sentence now starts a mission.
  await page.goto(`${governor.url}/settings?tab=work`);
  await page.locator("[data-work-queue]").getByLabel("Most tasks waiting", { exact: true }).fill("5");
  await page.locator("[data-work-queue]").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-work-queue-current]")).toHaveText("1 waiting now, limit 5.", { timeout: 30_000 });
  await expect(page.locator("[data-work-queue]")).toHaveAttribute("data-work-queue", "open");
  await page.goto(`${governor.url}/w/ws-queue/today`);
  await page.getByLabel(/^What do you want done/).fill("Draft the offsite agenda");
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/, { timeout: 30_000 });
  expect(missionCount()).toBe(missionsBefore + 1);
  expect(errors).toEqual([]);
});
