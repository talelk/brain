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
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
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

  async function select(label: string, option: string) {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function createPersonal(title: string, offlinePolicy: "wait" | "fail") {
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Target id", { exact: true }).fill("fixture-workflow");
    await select("Trigger", "Manual (Run now)");
    await select("Execution host", "Personal host only");
    await page.getByLabel("Personal runner id", { exact: true }).fill("personal-browser");
    if (offlinePolicy === "fail") await select("When the personal host is offline", "Fail the occurrence without starting a run");
    await page.getByLabel("Workflow input (JSON, optional)", { exact: true }).fill('{"message":"scheduled"}');
    await page.getByRole("button", { name: "Create automation", exact: true }).click();
    const article = page.locator("article").filter({ hasText: title });
    await expect(article).toContainText(`offline ${offlinePolicy}`);
    return article;
  }

  await page.goto(`${governor.url}/w/ws-schedules/schedules`);
  const waiting = await createPersonal("Personal wait", "wait");
  await waiting.getByRole("button", { name: "Run now", exact: true }).click();
  await waiting.getByRole("button", { name: "History", exact: true }).click();
  await expect(waiting).toContainText(/pending/i);
  await expect(waiting).toContainText("offline policy wait");
  expect((brain.store.control.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(0);

  brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='personal-browser'").run(brain.store.now());
  expect(brain.runAutomationDispatch().dispatched).toBe(1);
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
  await expect(failing).toContainText("offline policy fail");
  expect((brain.store.control.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(1);
  expect(errors).toEqual([]);
});
