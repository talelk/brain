import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { createApp } from "../../apps/governor/src/http/app";
import { fixtureStarter } from "../support/starter";

// A first-time admin sets up a ticket trigger from the Schedules screen instead of the API: picks what arrives and the Play it starts, reads
// that the plan waits for them, pauses and resumes it, sees a new ticket start a mission, switches it to incidents, and retires it. A second
// trigger repeats the plan of an earlier achieved mission under the ADR 0017 safety conditions.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${page.viewportSize()?.width}.png`), fullPage: true });
};

type Governor = { url: string; credential: string; app: Awaited<ReturnType<typeof createApp>> };

/** The real first-run form, a workspace with the starter Plays, and a way to deliver a new ticket (what the GitLab connector does on discovery). */
async function setup(page: Page, governor: Governor) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Trigger organization");
  await page.getByLabel(/^Email/).fill("triggers@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-triggers", slug: "triggers" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const workspace = brain.store.workspaceDb("ws-triggers", actor.organizationId);
  const ticket = (id: string) => {
    workspace.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms, created_at_ms) VALUES (?,'gitlab',?,'open','Customer cannot sign in',?,'v1',?,?)")
      .run(id, id, `sha256:${"1".repeat(64)}`, brain.store.now(), brain.store.now());
    return brain.jobProtocol.automations.fireSubject(actor.organizationId, "ws-triggers", { pack: "support", kind: "ticket", id });
  };
  const pick = async (label: string, option: string) => {
    await page.getByRole("dialog").getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  return { brain, actor, workspace, ticket, pick, cookie };
}

test("schedules: a ticket trigger is set up, paused, resumed, fired by a new ticket, revised and retired", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { ticket, pick } = await setup(page, governor);

  await page.goto(`${governor.url}/w/ws-triggers/schedules`);
  const panel = page.getByRole("region", { name: "Schedules", exact: true });
  const sheet = page.getByRole("dialog");

  // 1. The trigger choice offers subjects; choosing it narrows the target to Plays and drops the timer-only settings.
  await panel.getByRole("button", { name: "New schedule", exact: true }).click();
  await sheet.getByLabel("Schedule title", { exact: true }).fill("Draft a reply to every new ticket");
  await pick("Trigger", "When a new ticket or incident arrives");
  await expect(sheet.getByLabel("What arrives", { exact: true })).toBeVisible();
  await sheet.getByLabel("Target", { exact: true }).click();
  const targets = page.getByRole("option");
  await expect(targets.first()).toContainText(/^Play · /u);
  for (const option of await targets.all()) await expect(option).toContainText(/^Play · /u);
  await page.getByRole("option", { name: "Play · Draft a customer support reply", exact: true }).click();
  await expect(sheet.getByLabel("Cron expression", { exact: true })).toHaveCount(0);
  await expect(sheet.getByLabel("Overlap", { exact: true })).toHaveCount(0);
  await expect(sheet.getByLabel("Execution host", { exact: true })).toHaveCount(0);
  await expect(sheet.getByLabel("Workflow input (JSON, optional)", { exact: true })).toHaveCount(0);
  // No achieved mission of this Play exists yet, so the plan can only wait for the person; the sheet says so in plain words.
  await expect(sheet.getByTestId("subject-plan")).toContainText("Each mission's plan waits in Needs you for your OK");
  await expect(sheet.getByTestId("schedule-review")).toHaveText("Draft a reply to every new ticket · starts the Play Draft a customer support reply: Starts when a new ticket arrives");
  await shot(page, "subject-trigger-editor");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();

  const card = page.locator("article").filter({ hasText: "Draft a reply to every new ticket" });
  await expect(card).toContainText("Each new ticket");
  await expect(card).toContainText("Starts when a new ticket arrives");
  await expect(card.getByTestId("subject-plan-summary")).toHaveText("Waits for your OK in Needs you");
  await expect(card.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);
  await expect(card).toContainText("Active");
  await page.waitForTimeout(500);
  await shot(page, "subject-trigger-card");

  // 2. Pause stops it, resume starts it again.
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(card).toContainText("Paused");
  expect(ticket("tkt-paused")).toBe(0);
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(card).toContainText("Active");

  // 3. A new ticket starts one mission from the Play; the history links to it.
  expect(ticket("tkt-1")).toBe(1);
  await card.getByRole("button", { name: "History", exact: true }).click();
  await expect(card.getByText(/dispatched/i)).toBeVisible();
  await card.getByTestId("occurrence-mission").click();
  await expect(page).toHaveURL(/\/missions\/mission-/u);
  await expect(page.getByRole("heading", { name: /Draft a customer support reply/u }).first()).toBeVisible();

  // 4. Revising it to incidents changes what it listens for.
  await page.goto(`${governor.url}/w/ws-triggers/schedules`);
  const again = page.locator("article").filter({ hasText: "Draft a reply to every new ticket" });
  await again.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(sheet.getByLabel("What arrives", { exact: true })).toContainText("A new ticket");
  await pick("What arrives", "A new incident");
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(again).toContainText("Each new incident");
  await expect(again).toContainText("revision 2");
  expect(ticket("tkt-2")).toBe(0);

  // 5. Retire keeps the history and stops the trigger.
  await again.getByRole("button", { name: "Retire", exact: true }).click();
  await page.getByRole("dialog").getByLabel(/^Retirement reason/).fill("Handled by hand now");
  await page.getByRole("dialog").getByRole("button", { name: "Retire schedule", exact: true }).click();
  await expect(again).toContainText("Retired");
  await again.getByRole("button", { name: "History", exact: true }).click();
  await expect(again.getByText(/dispatched/i)).toBeVisible();
  expect(errors).toEqual([]);
});

test("schedules: a ticket trigger can repeat the plan of an achieved mission, and says when the plan still waits for the person", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, cookie, workspace, ticket, pick } = await setup(page, governor);
  // An earlier mission from the Play: confirmed plan, verified evidence, closed as achieved.
  const owner = (await brain.resolveActor(new Headers({ cookie }), "ws-triggers")).actor;
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-triggers", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const source = (await command("mission.create", "source", { title: "Reply to the first customer", playId: "support-reply-draft" })).resourceId ?? "";
  const plan = workspace.prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(source) as { id: string };
  const version = (workspace.prepare("SELECT version FROM missions WHERE id=?").get(source) as { version: number }).version;
  await command("plan.confirm", "source-confirm", { planVersionId: plan.id }, version);
  workspace.prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"a".repeat(64)}`, source, Date.now());
  workspace.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(source);

  await page.goto(`${governor.url}/w/ws-triggers/schedules`);
  const sheet = page.getByRole("dialog");
  await page.getByRole("region", { name: "Schedules", exact: true }).getByRole("button", { name: "New schedule", exact: true }).click();
  await sheet.getByLabel("Schedule title", { exact: true }).fill("Repeat the first reply");
  await pick("Trigger", "When a new ticket or incident arrives");
  await pick("Target", "Play · Draft a customer support reply");
  await pick("Repeat the plan of", "Reply to the first customer");
  // The switch and its plain explanation of the ADR 0017 conditions appear with the choice.
  await expect(sheet.getByTestId("subject-plan")).toContainText("as long as that plan is unchanged");
  await expect(sheet.getByTestId("subject-plan").getByRole("checkbox")).toBeChecked();
  await shot(page, "subject-trigger-repeat");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  const card = page.locator("article").filter({ hasText: "Repeat the first reply" });
  await expect(card.getByTestId("subject-plan-summary")).toHaveText("Confirmed automatically under the safety conditions");

  // A new ticket starts a mission whose plan the trigger confirmed: nothing waits for the person.
  expect(ticket("tkt-1")).toBe(1);
  const mission = (workspace.prepare("SELECT dispatch_ref FROM automation_occurrences WHERE state='dispatched'").get() as { dispatch_ref: string }).dispatch_ref;
  expect(workspace.prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(mission)).toEqual({ state: "confirmed" });

  // Switching the confirmation off makes the next mission wait, and the person can see why in Needs you.
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByRole("checkbox").uncheck({ force: true });
  await expect(sheet.getByTestId("subject-plan")).toContainText("waits in Needs you until you confirm it");
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(card.getByTestId("subject-plan-summary")).toHaveText("Waits for your OK each time (automatic confirmation is off)");
  expect(ticket("tkt-2")).toBe(1);
  await page.getByRole("button", { name: /Needs you/u }).first().click();
  await expect(page.getByText(/needs your OK: this schedule is set to ask you each time/u).first()).toBeVisible();
  expect(errors).toEqual([]);
});
