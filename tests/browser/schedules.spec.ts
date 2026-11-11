import { test, expect } from "./fixtures";
import { goldenDocs, DIGEST_A } from "../helpers";

test("schedules: personal-host offline wait, recovery and fail are explicit (T58, E104/E105)", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Scheduling organization");
  await page.getByLabel(/^Email/).fill("schedules@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-schedules", slug: "schedules" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  brain.store.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity)
    VALUES ('personal-browser',?,'fixture-tools','key','enabled','healthy',?,1,?,4000,8192,20480,1)`).run(actor.organizationId, DIGEST_A, brain.store.now() - 60_000);
  for (const capability of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    brain.store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES ('personal-browser',?,1,'fixture',?,?)")
      .run(capability, brain.store.now(), brain.store.now() + 3600_000);
  }

  const panel = page.getByRole("region", { name: "Schedules", exact: true });
  const sheet = page.getByRole("dialog");
  async function select(label: string, option: string) {
    await sheet.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function createPersonal(title: string, offlinePolicy: "wait" | "fail") {
    await panel.getByRole("button", { name: "New schedule", exact: true }).click();
    await sheet.getByLabel("Schedule title", { exact: true }).fill(title);
    await select("Trigger", "Manual (Run now)");
    await select("Execution host", "Personal host only");
    await sheet.getByLabel("Personal runner id", { exact: true }).fill("personal-browser");
    if (offlinePolicy === "fail") await select("When the personal host is offline", "Fail the occurrence without starting a run");
    await sheet.getByLabel("Workflow input (JSON, optional)", { exact: true }).fill('{"message":"scheduled"}');
    await page.getByRole("button", { name: "Create automation", exact: true }).click();
    const article = page.locator("article").filter({ hasText: title });
    await expect(article).toContainText(`offline ${offlinePolicy}`);
    return article;
  }

  await page.goto(`${governor.url}/w/ws-schedules/schedules?target=fixture-workflow`);
  const waiting = await createPersonal("Personal wait", "wait");
  await waiting.getByRole("button", { name: "Run now", exact: true }).click();
  await waiting.getByRole("button", { name: "History", exact: true }).click();
  await expect(waiting).toContainText(/pending/i);
  await expect(waiting).toContainText("the run starts when it is back");
  expect((brain.store.control.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(0);

  brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='personal-browser'").run(brain.store.now());
  expect(brain.jobProtocol.dispatchAutomations().dispatched).toBe(1);
  await waiting.getByRole("button", { name: "Hide history", exact: true }).click();
  await waiting.getByRole("button", { name: "History", exact: true }).click();
  await expect(waiting).toContainText(/dispatched/i);
  const placement = brain.store.control.prepare("SELECT placement_json FROM jobs").get() as { placement_json: string };
  expect(JSON.parse(placement.placement_json).runnerId).toBe("personal-browser");

  brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='personal-browser'").run(brain.store.now() - 60_000);
  const failing = await createPersonal("Personal fail", "fail");
  await failing.getByRole("button", { name: "Run now", exact: true }).click();
  await failing.getByRole("button", { name: "History", exact: true }).click();
  await expect(failing).toContainText(/failed/i);
  await expect(failing).toContainText("set to fail rather than wait");
  expect((brain.store.control.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(1);
  expect(errors).toEqual([]);
});

test("schedules: revise, duplicate and retire without deleting occurrence history", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Schedule lifecycle organization");
  await page.getByLabel(/^Email/).fill("schedule-lifecycle@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-schedule-lifecycle", slug: "schedule-lifecycle" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);

  await page.goto(`${governor.url}/w/ws-schedule-lifecycle/schedules?target=fixture-workflow`);
  const panel = page.getByRole("region", { name: "Schedules", exact: true });
  const sheet = page.getByRole("dialog");
  await panel.getByRole("button", { name: "New schedule", exact: true }).click();
  await sheet.getByLabel("Schedule title", { exact: true }).fill("Lifecycle original");
  await sheet.getByLabel("Trigger", { exact: true }).click();
  await page.getByRole("option", { name: "Manual (Run now)", exact: true }).click();
  await sheet.getByLabel("Workflow input (JSON, optional)", { exact: true }).fill('{"message":"scheduled"}');
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  let original = page.locator("article").filter({ hasText: "Lifecycle original" });
  await expect(original).toContainText("revision 1");

  await original.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByLabel("Schedule title", { exact: true }).fill("Lifecycle revised");
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  original = page.locator("article").filter({ hasText: "Lifecycle revised" });
  await expect(original).toContainText("revision 2");
  await original.getByRole("button", { name: "Run now", exact: true }).click();
  await original.getByRole("button", { name: "History", exact: true }).click();
  await expect(original).toContainText(/dispatched/i);

  await original.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(sheet.getByLabel("Schedule title", { exact: true })).toHaveValue("Copy of Lifecycle revised");
  await sheet.getByLabel("Schedule title", { exact: true }).fill("Lifecycle duplicate");
  await page.getByRole("button", { name: "Create duplicate", exact: true }).click();
  const duplicate = page.locator("article").filter({ hasText: "Lifecycle duplicate" });
  await expect(duplicate).toContainText("revision 1");
  await original.getByRole("button", { name: "Hide history", exact: true }).click();

  await original.getByRole("button", { name: "Retire", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Retirement reason/).fill("Replaced by the duplicate");
  await dialog.getByRole("button", { name: "Retire schedule", exact: true }).click();
  await expect(original).toContainText("Retired");
  await expect(original.getByRole("button", { name: "Run now", exact: true })).toBeDisabled();
  await original.getByRole("button", { name: "History", exact: true }).click();
  await expect(original).toContainText(/dispatched/i);
  const states = brain.store.workspaceDb("ws-schedule-lifecycle", actor.organizationId).prepare("SELECT state,COUNT(*) AS count FROM automations GROUP BY state").all() as Array<{ state: string; count: number }>;
  expect(states).toEqual(expect.arrayContaining([{ state: "active", count: 1 }, { state: "retired", count: 1 }]));
  expect(errors).toEqual([]);
});
