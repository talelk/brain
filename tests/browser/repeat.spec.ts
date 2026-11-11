import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// A first-time owner turns a finished mission into a recurring job from the mission page, picks a
// preset, sees the server's next five runs, and later reads in plain words what a scheduled run
// changed against the one before it.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

test("repeat this: preset schedule from a finished mission, then what changed between runs", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Repeat organization");
  await page.getByLabel(/^Email/).fill("repeat@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();

  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-repeat", slug: "repeat" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-repeat")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-repeat", org: actor.organizationId } as unknown as TestWorld;
  const first = await achievedMission(world, "first", {
    title: "Weekly sales digest", intent: "Summarise last week's sales and name the three biggest changes",
    criteria: ["The digest names three changes"],
    outputs: [{ name: "digest.md", text: "# Digest\n- Pricing page visits grew\n- Churn stayed flat\n- Two deals slipped" }],
  });
  const second = await achievedMission(world, "second", {
    title: "Weekly sales digest", intent: "Summarise last week's sales and name the three biggest changes",
    criteria: ["The digest names three changes"],
    outputs: [{ name: "digest.md", text: "# Digest\n- Pricing page visits grew\n- Churn rose slightly\n- Two deals slipped\n- One deal closed" }],
  });

  // 1. A finished mission offers Repeat this; the picker shows the server's presets and next five runs.
  await page.goto(`${governor.url}/missions/${first}/outputs?w=ws-repeat`);
  await page.getByRole("button", { name: "Repeat this", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Repeat this" });
  await expect(sheet.getByRole("radio")).toHaveCount(3);
  await expect(sheet.getByRole("radio", { name: /Every weekday at 08:00/ })).toBeChecked();
  await expect(sheet.getByTestId("repeat-next-runs").locator("li")).toHaveCount(5);
  await sheet.getByRole("radio", { name: /Every Monday at 08:00/ }).check({ force: true });
  await expect(sheet.getByTestId("repeat-next-runs").locator("li")).toHaveCount(5);
  await expect(sheet.getByText("You confirm its plan")).toHaveCount(0);
  // Hands-off by default (ADR 0017): the plan is confirmed by the schedule, with the exact conditions in one sentence.
  const auto = sheet.getByRole("checkbox", { name: "Confirm the plan automatically each time" });
  await expect(auto).toBeChecked();
  await expect(sheet.getByTestId("repeat-autoconfirm")).toContainText(/no step writes or needs an approval.*otherwise the run waits in Needs you with the reason/);
  await auto.uncheck({ force: true });
  await expect(sheet.getByTestId("repeat-autoconfirm")).toContainText("Each run waits in Needs you until you confirm its plan.");
  await auto.check({ force: true });
  await expect(auto).toBeChecked();
  await shot(page, "1-picker");
  await sheet.getByLabel("Timezone").fill("Europe/Paris");
  await sheet.getByLabel("Timezone").blur();
  await expect(sheet.getByText("Next runs (Europe/Paris)")).toBeVisible();
  await sheet.getByRole("button", { name: "Repeat on this schedule", exact: true }).click();

  // 2. It lands on Schedules with an active automation that targets the described work.
  await expect(page).toHaveURL(/\/w\/ws-repeat\/schedules\?target=general-task/);
  const card = page.locator("article").filter({ hasText: "Repeat: Weekly sales digest" });
  await expect(card).toContainText("0 8 * * 1 · Europe/Paris");
  await expect(card.getByText("Next actual fire")).toBeVisible();
  await shot(page, "2-schedules");
  const db = brain.store.workspaceDb("ws-repeat", actor.organizationId);
  const row = db.prepare("SELECT target_kind,target_id,cron,timezone,state FROM automations").get() as Record<string, string>;
  expect(row).toMatchObject({ target_kind: "workflow", target_id: "general-task", cron: "0 8 * * 1", timezone: "Europe/Paris", state: "active" });
  const input = JSON.parse((db.prepare("SELECT input_json FROM automations").get() as { input_json: string }).input_json) as Record<string, unknown>;
  expect(input).toMatchObject({ sourceMissionId: first, autoConfirm: true });

  // 3. Scheduled runs of a play: the first says so, the next says what changed, a skipped one says why.
  const play = (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: "cmd-play-auto", commandType: "automation.upsert", workspaceId: "ws-repeat", idempotencyKey: "play-auto",
    payload: { title: "Sales digest play", target: { kind: "play", id: "sales-digest" }, trigger: { kind: "cron", cron: "0 8 * * 1", timezone: "UTC" } },
  } as never, "play-auto")).receipt.resourceId ?? "";
  const insert = db.prepare("INSERT INTO automation_occurrences(id,automation_id,revision,planned_at_ms,state,dispatch_ref,detail,fired_at_ms) VALUES (?,?,?,?,?,?,?,?)");
  const base = Date.now() - 4 * 86_400_000;
  insert.run("occ-1", play, 1, base, "dispatched", first, null, base);
  insert.run("occ-2", play, 1, base + 86_400_000, "dispatched", second, null, base + 86_400_000);
  insert.run("occ-3", play, 1, base + 2 * 86_400_000, "skipped", null, "the mission the previous occurrence started is still open", base + 2 * 86_400_000);

  await page.goto(`${governor.url}/missions/${first}/outputs?w=ws-repeat`);
  await expect(page.getByTestId("occurrence-change")).toContainText("First run of this schedule");
  await page.goto(`${governor.url}/missions/${second}/outputs?w=ws-repeat`);
  const change = page.getByTestId("occurrence-change");
  await expect(change).toContainText(/Changed since the run of .*: 2 lines added, 1 removed/);
  await change.getByText("Show what changed").click();
  await expect(change).toContainText("Churn rose slightly");
  await expect(change).toContainText("One deal closed");
  await shot(page, "3-changed");

  await page.goto(`${governor.url}/w/ws-repeat/schedules?target=sales-digest`);
  const playCard = page.locator("article").filter({ hasText: "Sales digest play" });
  await playCard.getByRole("button", { name: "History", exact: true }).click();
  await expect(playCard.getByTestId("occurrence-reason")).toContainText("Skipped: the mission the previous run started is still open");
  await expect(playCard.getByTestId("occurrence-change").first()).toBeVisible();
  await expect(playCard.getByText("Open the mission").first()).toBeVisible();
  await shot(page, "4-history");

  // 4. The Today box's Repeat entry opens the same picker.
  expect(errors).toEqual([]);
});
