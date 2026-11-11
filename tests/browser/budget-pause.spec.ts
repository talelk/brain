import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { ActorContext, Mission } from "@brain/contracts";
import { totpCode } from "../support/totp";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * A budget pause is settled on Today (backlog 36, ADR 0016): the item names the limit that was reached and one click adds time and
 * resumes, recorded as a limit change. A plan whose own estimate is longer than a limit a person named warns before Confirm.
 */
test.use({ requireTwoFactor: true });
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("a time pause is resumed from Today with +30 min; the plan warns when a named limit is below its estimate", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Budget organization");
  await page.getByLabel(/^Email/).fill("budget@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Authenticator setup" })).toBeVisible();
  await page.getByLabel(/^Confirm password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  const link = page.getByRole("link", { name: "Keyrus Brain to your authenticator", exact: true });
  await expect(link).toBeVisible();
  const secret = new URL((await link.getAttribute("href"))!).searchParams.get("secret")!;
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(page.getByRole("region", { name: "Authenticator setup" })).toHaveCount(0);

  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor: ActorContext = (await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-budget", slug: "budget" });
  const ws: ActorContext = { ...actor, workspaceId: "ws-budget", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-budget") };
  const db = brain.store.workspaceDb("ws-budget", actor.organizationId);
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-budget", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const mission = async (id: string): Promise<Mission> => ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-budget", resourceId: id })) as unknown as { snapshot: Mission }).snapshot;

  // A mission whose 30 minute limit a person named and whose plan estimates 85 minutes: the proposal warns before Confirm.
  const named = (await cmd("mission.create", "named-create", { title: "Rotate on-call duty", intent: "Write the runbook", successCriteria: ["done"], autoStart: false, budget: { maxWallClockMs: 1_800_000, maxMicroUsd: 2_000_000, memberCap: 2 } })).resourceId ?? "";
  await cmd("plan.propose", "named-plan", { missionId: named, origin: "manual", summary: "Plan for the runbook", tasks: [{ id: "t", title: "Draft the runbook", criteria: ["It exists"], dependsOn: [], estimatedMinutes: 85 }] });

  // A paused mission whose time limit was reached, with a dollar budget that must survive the click.
  const paused = (await cmd("mission.create", "paused-create", { title: "Weekly status", intent: "Write the status", successCriteria: ["done"], autoStart: false, budget: { maxWallClockMs: 1_800_000, maxMicroUsd: 2_000_000, memberCap: 2 } })).resourceId ?? "";
  db.prepare("UPDATE missions SET state='paused', pause_reason='budget', budget_wall_ms=0 WHERE id=?").run(paused);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${governor.url}/w/ws-budget/today`);
  const queue = page.getByTestId("needs-you");
  const planRow = queue.getByTestId("needs-you-item").filter({ hasText: "Plan proposal for Rotate on-call duty" });
  await expect(planRow.getByTestId("estimate-time-warning")).toContainText("shorter than this plan's own estimate");
  await expect(planRow.getByTestId("estimate-ceiling")).toContainText("This plan stops at $2 or 30 min of working time");
  const row = queue.locator('[data-kind="budget-pause"]');
  await expect(row).toContainText("time limit reached");
  await expect(row.getByTestId("budget-add-1usd")).toHaveCount(0);
  await shot(page, "budget-pause-today");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "budget-pause-today");
  await page.setViewportSize({ width: 1440, height: 900 });

  await row.getByTestId("budget-add-30min").click();
  await expect.poll(async () => (await mission(paused)).state).toBe("active");
  const after = await mission(paused);
  expect(after.budget).toMatchObject({ maxWallClockMs: 1_800_000, maxMicroUsd: 2_000_000, memberCap: 2 }); // money kept, time raised
  await expect(queue.locator('[data-kind="budget-pause"]')).toHaveCount(0, { timeout: 15_000 });
  const note = db.prepare("SELECT payload_json FROM events WHERE aggregate_id=? AND event_type='mission.budgetChanged' ORDER BY cursor DESC LIMIT 1").get(paused) as { payload_json: string } | undefined;
  expect(note ? JSON.parse(note.payload_json) : {}).toMatchObject({ by: actor.actorId, note: expect.stringContaining("time limit 0 min to 30 min") });
  expect(errors).toEqual([]);
});
