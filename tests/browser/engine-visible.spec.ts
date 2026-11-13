import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";

/**
 * What the engine now knows is visible and usable in plain words (backlog rows 84, 89, 94): why a task stopped and the one fix
 * (with a raise-the-spend-cap action), Quality by cause and by practice, the settings an owner makes under "How work runs",
 * company single sign-on, the Git connection checklist, practices and a tool's own test.
 */
const ws = (demo: { workspaceId: string }, governor: { app: { brain: import("../../apps/governor/src/application/brain").Brain } }) => {
  const brain = governor.app.brain;
  const row = brain.store.control.prepare("SELECT organization_id AS org FROM workspaces WHERE id=?").get(demo.workspaceId) as { org: string };
  return { brain, db: brain.store.workspaceDb(demo.workspaceId, row.org), org: row.org };
};

test("a stopped task says why in one sentence and offers the one fix; raising the spend cap sets it going again", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const { db } = ws(demo, governor);
  const blocked = demo.seed.workItems.blocked;
  db.prepare("UPDATE work_items SET parked=1, state='blocked', failure_class='budget', parked_diagnostic='The task used its whole token allowance across attempts', blocked_reason='Parked: the task used its token allowance', required_tools_json='[\"documents.read\"]' WHERE id=?").run(blocked);

  // Today: the decision card carries the sentence, the fix and the one-click raise.
  await page.goto(`${governor.url}/w/${demo.workspaceId}/today`);
  const card = page.getByTestId("needs-you-item").filter({ hasText: "Collect production traces" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("[data-task-failure-sentence]")).toHaveText("The task used up its spend allowance");
  await expect(card.locator("[data-task-failure-fix]")).toContainText("Raise this task's spend cap so it can finish.");
  await expect(card.getByRole("button", { name: "Raise the spend cap to 400,000 tokens" })).toBeVisible();

  // The task page: the same sentence, and the cap can be set to a number of your choice.
  await page.goto(`${governor.url}/missions/${demo.seed.missionIds.active}/plan`);
  await page.getByRole("button", { name: "Manage Collect production traces", exact: true }).click();
  const parked = page.locator("[data-spend-cap-raise]");
  await expect(page.locator("[data-task-failure-sentence]")).toHaveText("The task used up its spend allowance", { timeout: 30_000 });
  await parked.getByLabel("New cap (tokens)").fill("100");
  await parked.getByRole("button", { name: "Raise the spend cap", exact: true }).click();
  await expect(parked.getByRole("alert")).toContainText("Enter more than the current cap");
  await parked.getByLabel("New cap (tokens)").fill("500000");
  await parked.getByRole("button", { name: "Raise the spend cap", exact: true }).click();
  await expect.poll(() => db.prepare("SELECT state, parked, token_cap AS cap FROM work_items WHERE id=?").get(blocked), { timeout: 30_000 }).toEqual({ state: "ready", parked: 0, cap: 500000 });
  expect(errors).toEqual([]);
});

test("Quality names failures by cause and breaks the figures down by practice and workspace", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const { brain, db } = ws(demo, governor);
  brain.store.control.prepare("UPDATE workspaces SET tags_json='[\"practice:data\"]' WHERE id=?").run(demo.workspaceId);
  db.prepare("UPDATE work_items SET parked=1, state='blocked', failure_class='missing-tool', parked_diagnostic='needs documents.read', updated_at_ms=? WHERE id=?").run(brain.store.now(), demo.seed.workItems.blocked);

  await page.goto(`${governor.url}/quality`);
  await expect(page.getByRole("heading", { name: "Quality", exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('[data-failure-code="missing-tool"]')).toContainText("The task needed a tool its way of working does not have");
  const practice = page.locator('[data-quality-row="practice:data"]');
  await expect(practice).toBeVisible({ timeout: 30_000 });
  await expect(practice).toContainText("Verified");
  await expect(practice.locator("[data-quality-trend]")).toHaveAttribute("aria-label", /Per day over the last 30 days: \d+ verified, \d+ stopped/);
  await expect(page.locator(`[data-quality-row="workspace:${demo.workspaceId}"]`)).toContainText("Operations");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("How work runs: way of working, hosted model (off), tool allow-list, runner groups, pausing new work and lessons", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  const { brain, db, org } = ws(demo, governor);
  const now = brain.store.now();
  db.prepare("INSERT INTO lessons(id,work_item_id,mission_id,failure_class,outcome,task_title,lesson,created_at_ms,expires_at_ms) VALUES ('lesson-1',?,?,'tool-outage','healed','Collect production traces','a tool was down when the task ran: it succeeds when retried later',?,?)")
    .run(demo.seed.workItems.blocked, demo.seed.missionIds.active, now, now + 86_400_000);

  await page.goto(`${governor.url}/settings?tab=work`);
  await expect(page.getByRole("heading", { name: "How work runs", exact: true, level: 1 })).toBeVisible();

  // Way of working: a released workflow and its tools.
  const way = page.locator("[data-work-way]");
  await expect(way).toBeVisible({ timeout: 30_000 });
  await way.getByLabel("Way of working", { exact: true }).click();
  await page.getByRole("option").first().click();
  await way.getByRole("button", { name: "Save", exact: true }).click();
  await expect(way.getByRole("status")).toHaveText("The way of working was saved.");
  await expect(page.locator("[data-work-way-current]")).toContainText("Now:");

  // Hosted model: off by default; cannot be switched on without its vendor, model and address.
  const hosted = page.locator("[data-work-hosted]");
  await expect(hosted).toContainText("Off");
  await hosted.getByRole("checkbox", { name: "Use a hosted model for this workspace" }).check();
  await hosted.getByRole("button", { name: "Save", exact: true }).click();
  await expect(hosted.getByRole("alert")).toContainText("Choose the vendor, the model and its address");
  await hosted.getByRole("checkbox", { name: "Use a hosted model for this workspace" }).uncheck();
  await hosted.getByRole("button", { name: "Save", exact: true }).click();
  await expect(hosted.getByRole("status")).toHaveText("The hosted model setting was saved.");

  // What tools may touch.
  const effects = page.locator("[data-work-effects]");
  await effects.getByLabel("Containers", { exact: true }).fill("web-1\nworker-2");
  await effects.getByLabel("Services", { exact: true }).fill("nginx");
  await effects.getByLabel("Approval waits (minutes)", { exact: true }).fill("45");
  await effects.getByRole("button", { name: "Save", exact: true }).click();
  await expect(effects.getByRole("status")).toHaveText("The allow-list was saved.");
  await expect.poll(() => brain.store.control.prepare("SELECT containers_json AS c, services_json AS s, approval_minutes AS m FROM workspace_effect_policy WHERE workspace_id=?").get(demo.workspaceId), { timeout: 30_000 })
    .toEqual({ c: '["web-1","worker-2"]', s: '["nginx"]', m: 45 });

  // Runner groups: one that may run host tools for this workspace.
  const groups = page.locator("[data-work-groups]");
  await groups.getByLabel("Group name", { exact: true }).fill("sre-host");
  await groups.getByRole("checkbox", { name: "This group may run tools that touch hosts" }).check();
  await groups.getByRole("checkbox", { name: "Operations", exact: true }).check();
  await groups.getByRole("button", { name: "Save", exact: true }).click();
  await expect(groups.getByRole("status")).toHaveText("The runner group was saved.");
  await expect(groups.locator('[data-runner-group="sre-host"]')).toContainText("Host tools allowed");
  expect(brain.store.control.prepare("SELECT host_tools AS h, workspaces_json AS w FROM runner_groups WHERE organization_id=? AND group_id='sre-host'").get(org)).toEqual({ h: 1, w: JSON.stringify([demo.workspaceId]) });

  // Pause new work, then resume.
  const drain = page.locator("[data-work-drain]");
  await expect(drain).toHaveAttribute("data-work-drain", "off");
  await drain.getByRole("button", { name: "Pause new work", exact: true }).click();
  await expect(drain).toHaveAttribute("data-work-drain", "on", { timeout: 30_000 });
  await drain.getByRole("button", { name: "Resume new work", exact: true }).click();
  await expect(drain).toHaveAttribute("data-work-drain", "off", { timeout: 30_000 });

  // The lesson Brain kept, in plain words.
  const lesson = page.locator('[data-lesson="tool-outage"]');
  await expect(lesson).toContainText("Collect production traces");
  await expect(lesson).toContainText("A tool was down · it healed");
  expect(errors).toEqual([]);
});

test("single sign-on is set with a reference to its secret, never the secret; the sign-in page offers the directory", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);
  process.env["BRAIN_OIDC_WEBTEST"] = "a-test-value-not-a-real-secret";
  try {
    await page.goto(`${governor.url}/settings?tab=policy`);
    await expect(page.getByRole("heading", { name: "Authentication", exact: true, level: 1 })).toBeVisible();
    const sso = page.locator("[data-sso]");
    await expect(sso).toHaveAttribute("data-sso-state", "none", { timeout: 30_000 });
    await expect(page.locator("[data-sso-redirect]")).toContainText("/api/auth/callback/");
    // The old false statement is gone.
    await expect(page.getByText("existing members only")).toHaveCount(0);
    // The secret is a reference field, not a password field.
    await expect(sso.getByLabel("Client secret reference")).toHaveAttribute("autocomplete", "off");
    expect(await sso.getByLabel("Client secret reference").getAttribute("type")).not.toBe("password");
    await sso.getByLabel("Directory address (issuer)").fill("https://login.example.test/tenant/v2.0");
    await sso.getByLabel("Client ID", { exact: true }).fill("brain-web-test");
    await sso.getByLabel("Client secret reference").fill("env:BRAIN_OIDC_WEBTEST");
    await sso.getByLabel("Directory field that lists a person's groups").fill("groups");
    await sso.getByLabel("Roles by directory group").fill("sre-team = operator\nnot a pair");
    await sso.getByRole("button", { name: "Save single sign-on", exact: true }).click();
    await expect(sso.getByRole("alert")).toContainText("not group = role");
    await sso.getByLabel("Roles by directory group").fill("sre-team = operator");
    await sso.getByRole("button", { name: "Save single sign-on", exact: true }).click();
    await expect(sso.getByRole("status")).toHaveText("Single sign-on was saved.");
    await expect(sso).toHaveAttribute("data-sso-state", "off");
    await expect(page.locator("[data-sso-secret]")).toHaveAttribute("data-sso-secret", "readable");
    const stored = governor.app.brain.store.control.prepare("SELECT secret_ref AS ref FROM identity_provider").get() as { ref: string } | undefined;
    expect(stored?.ref).toBe("env:BRAIN_OIDC_WEBTEST");
    expect(await page.content()).not.toContain("a-test-value-not-a-real-secret");
  } finally { delete process.env["BRAIN_OIDC_WEBTEST"]; }

  // Signed out, the directory is one more way in, and the approval link survives the round trip.
  const context = await page.context().browser()!.newContext();
  const guest = await context.newPage();
  await guest.route("**/v1/auth/providers", (route) => route.fulfill({ json: { password: true, sso: { providerId: "oidc", label: "Company directory", startPath: "/v1/auth/sso/start" } } }));
  let started = "";
  await guest.route("**/v1/auth/sso/start**", (route) => { started = route.request().url(); return route.fulfill({ status: 200, contentType: "text/plain", body: "directory" }); });
  await guest.goto(`${governor.url}/approvals/apr-deep-link`);
  await guest.getByRole("button", { name: "Sign in with the company directory" }).click();
  await expect.poll(() => started, { timeout: 30_000 }).toContain("/v1/auth/sso/start?next=%2Fapprovals%2Fapr-deep-link");
  await context.close();
  expect(demo.workspaceId).toBe("operations");
  expect(errors).toEqual([]);
});

test("the Git connection checklist says what is missing; practices offer a Play from verified missions; a tool's own test shows its result", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const demo = await seedBrowserDemo(page, governor);

  // Nothing connected: the first step is to add a connection.
  await page.goto(`${governor.url}/administration/integrations`);
  const guide = page.locator("[data-git-guide]");
  await expect(guide).toHaveAttribute("data-ready", "no", { timeout: 30_000 });
  await expect(guide.locator('[data-guide-step="connect"]')).toContainText("Add a Git connection");
  await expect(guide.locator('[data-guide-step="connect"]')).toContainText("To do");
  await expect(page.locator("[data-git-guide-verdict]")).toHaveText("Not ready yet: finish the steps below.");

  // Practices: the action exists, and says why it cannot run yet.
  await page.goto(`${governor.url}/w/${demo.workspaceId}/library`);
  const practices = page.locator("[data-practices]");
  await expect(practices).toBeVisible({ timeout: 30_000 });
  const first = practices.locator("[data-practice]").first();
  await expect(first.getByRole("button", { name: "Propose a Play from our verified missions", exact: true })).toBeDisabled();
  await expect(first).toContainText("Not enough verified missions yet.");
  expect(errors).toEqual([]);
});

test("a tool's own test shows its verdict, exit code and output", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const demo = await seedBrowserDemo(page, governor);
  const { brain, db, org } = ws(demo, governor);
  const tools = await brain.executeQuery((await brain.resolveActor(new Headers({ cookie: (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }), demo.workspaceId)).actor, { queryType: "tools.list", workspaceId: demo.workspaceId }) as unknown as { snapshot: { items: { id: string; effectClass: string }[] } };
  const tool = tools.snapshot.items[0];
  test.skip(!tool, "the fixture release carries no tool");
  const run = "run-selftest-1";
  brain.store.control.prepare("INSERT INTO tool_test_runs(id,organization_id,workspace_id,tool_id,release_digest,run_id,input_json,requested_by,created_at_ms,kind) VALUES ('tt-1',?,?,?,?,?,'{}','demo',?,'selftest')")
    .run(org, demo.workspaceId, tool!.id, `sha256:${"a".repeat(64)}`, run, brain.store.now());
  db.prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,'succeeded',?,?)").run(run, `key-${run}`, `sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`, `engine-${run}`, `sha256:${"a".repeat(64)}`, brain.store.now());
  db.prepare("INSERT INTO workflow_steps(run_id,step_id,execution_key,state) VALUES (?,'test',?,'succeeded')").run(run, `key-${run}-test`);
  db.prepare("INSERT INTO step_outputs(run_id,step_id,output_json) VALUES (?,'test',?)").run(run, JSON.stringify({ passed: false, exitCode: 2, output: "expected 3 rows, got 2" }));
  await page.goto(`${governor.url}/w/${demo.workspaceId}/knowledge?tab=tools`);
  await page.getByText(tool!.id, { exact: true }).first().click();
  const result = page.locator('[data-tool-test-kind="selftest"]').first();
  await expect(result).toHaveAttribute("data-selftest-verdict", "failed", { timeout: 30_000 });
  await expect(result.locator("[data-selftest-summary]")).toHaveText("The test script failed (exit code 2).");
  await result.getByText("What the script printed").click();
  await expect(result.locator("[data-selftest-output]")).toHaveText("expected 3 rows, got 2");
  await expect(page.getByRole("button", { name: "Run the tool's own test" })).toBeVisible();
});
