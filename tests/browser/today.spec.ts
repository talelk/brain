import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { goldenDocs } from "../helpers";
import type { TestWorld } from "../helpers";
import { achievedMission } from "../support/reuse";
import { enrollRunners } from "../support/flow";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * Today (#47) and its reuse entries (#69), driven as a first-time user would:
 * land, type one sentence, press Start, arrive on the plan with a default
 * budget; start from a play chip, from a previous mission, and repeat one.
 */
const SOURCE = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";
const agent = { path: "config/builder.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: builder\n  version: 1.0.0\nspec:\n  instructionsPath: agents/builder.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n" };
const play = { path: "config/plays/auth-stabilize.yaml", text: `apiVersion: brain.keyrus/v1
kind: Play
metadata:
  id: auth-stabilize
  version: 1.0.0
spec:
  title: Stabilize authentication
  intent: Find and fix session expiry
  successCriteria: [Sessions survive restarts]
  constraints: [Keep the public API]
  team:
    - { memberId: lead, role: Coordinator, agentId: builder, engine: pi }
    - { memberId: backend, role: Backend engineer, agentId: builder, engine: pi }
  coordinator: lead
  plan:
    tasks:
      - { id: audit, title: Audit sessions, criteria: [audit-done], dependsOn: [], assignment: { kind: agent, id: backend, role: specialist } }
  autonomy: autonomous
  parkingThreshold: 2
  budget: { maxMicroUsd: 500000, memberCap: 2 }
` };

async function world(page: Page, governor: { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } }) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Today organization");
  await page.getByLabel(/^Email/).fill("today@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-today", slug: "today" });
  const release = brain.stageRelease(actor, [...goldenDocs(), agent, play], SOURCE, [], [{ agentId: "builder", path: "agents/builder.md", text: "# Builder\n" }]);
  brain.activateRelease(actor, release.digest);
  // An installed machine: online runners for the release's groups, so the box is not blocked by setup.
  await enrollRunners(governor, actor, "today", ["fixture-tools", "fixture-evaluators"]);
  const ws = { ...actor, workspaceId: "ws-today", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-today") };
  const db = brain.store.workspaceDb("ws-today", actor.organizationId);
  return { brain, actor, ws, db };
}
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("a first-time user lands on Today, types one sentence, presses Start and reaches the plan with the default budget; plays are chips", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const w = await world(page, governor);

  // The bare route opens Today: nothing is active and nothing waits.
  await page.goto(governor.url);
  await expect(page).toHaveURL(/\/w\/ws-today\/today$/);
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const box = page.getByLabel(/^What do you want done/);
  await expect(box).toBeVisible();
  await expect(page.getByRole("button", { name: "Stabilize authentication", exact: true })).toBeVisible();
  await shot(page, "today-empty");

  // Submitting with nothing typed says what is missing; nothing is created.
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("Say in a sentence what you want done.")).toBeVisible();
  expect((w.db.prepare("SELECT COUNT(*) AS c FROM missions").get() as { c: number }).c).toBe(0);

  await box.fill("Summarise this week's support tickets and draft replies");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const row = w.db.prepare("SELECT title, budget_micro_usd, auto_start FROM missions").get() as { title: string; budget_micro_usd: number | null; auto_start: number };
  expect(row.title).toBe("Summarise this week's support tickets and draft replies");
  expect(row.budget_micro_usd).toBe(5_000_000); // the Governor's documented default
  expect(row.auto_start).toBe(1);
  await shot(page, "plan-after-start");

  // A play chip seeds the mission with that play, including its own budget.
  await page.goto(`${governor.url}/w/ws-today/today`);
  await page.getByRole("button", { name: "Stabilize authentication", exact: true }).click();
  await expect(page.getByTestId("start-seed")).toContainText("Stabilize authentication");
  await shot(page, "today-play-picked");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const fromPlay = w.db.prepare("SELECT play_id, budget_micro_usd FROM missions WHERE play_id IS NOT NULL").get() as { play_id: string; budget_micro_usd: number };
  expect(fromPlay).toEqual({ play_id: "auth-stabilize", budget_micro_usd: 500_000 });

  // The Today page now leads with the box and lists the latest missions.
  await page.goto(`${governor.url}/w/ws-today/today`);
  await expect(page.getByRole("region", { name: "Latest missions" })).toBeVisible();
  await shot(page, "today-with-missions");
  expect(errors).toEqual([]);
});

test("the New mission dialog is the same box on every open: no mode toggle, one sentence is enough", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const w = await world(page, governor);
  for (let open = 0; open < 2; open += 1) {
    await page.goto(`${governor.url}/w/ws-today/missions/new`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^What do you want done/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Describe what you want|Start from a play/ })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Stabilize authentication", exact: true })).toBeVisible();
  }
  await shot(page, "new-mission-dialog");
  await page.getByRole("dialog").getByLabel(/^What do you want done/).fill("Write the launch note");
  await page.getByRole("dialog").getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  expect((w.db.prepare("SELECT budget_micro_usd AS b FROM missions").get() as { b: number }).b).toBe(5_000_000);
});

test("reuse entries: empty state, start from a previous mission via the reuse index (names the source), Repeat this, phone width", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const w = await world(page, governor);
  await page.goto(`${governor.url}/w/ws-today/today`);
  await page.getByRole("button", { name: "Start from a previous mission", exact: true }).click();
  await expect(page.getByText("Type a few words above or here")).toBeVisible();
  await page.getByLabel("Search verified missions").fill("weekly digest");
  await expect(page.getByText("Nothing to reuse yet for that.")).toBeVisible();
  await shot(page, "today-reuse-empty");

  // One verified (achieved, capitalized) mission described by hand, and one closed mission that came from a play.
  const command = async (commandType: string, key: string, payload: Record<string, unknown>) => (await w.brain.executeCommand(w.ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-today", idempotencyKey: key, payload,
  } as never, key)).receipt;
  const fromPlay = (await command("mission.create", "r-play", { title: "Auth sweep", playId: "auth-stabilize" })).resourceId ?? "";
  w.db.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(fromPlay);
  const testWorld = { brain: w.brain, owner: w.ws, workspaceId: "ws-today", org: w.actor.organizationId } as unknown as TestWorld;
  const described = await achievedMission(testWorld, "digest", { title: "Weekly digest", intent: "Write the weekly digest of support tickets", criteria: ["digest written"] });

  await page.goto(`${governor.url}/w/ws-today/today`);
  await page.getByLabel(/^What do you want done/).fill("weekly digest of support tickets");
  await page.getByRole("button", { name: "Start from a previous mission", exact: true }).click();
  const list = page.getByRole("region", { name: "Choose a previous mission" });
  const row = list.getByRole("button", { name: "Start from Weekly digest" });
  await expect(row).toContainText("Achieved mission");
  await expect(row).toContainText("Last verified");
  await shot(page, "today-reuse-list");
  await row.click();
  await expect(page.getByTestId("start-seed")).toContainText("Weekly digest");
  await page.getByLabel(/^What do you want done/).fill("");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const seeded = w.db.prepare("SELECT m.id, m.intent, m.success_criteria_json AS criteria, b.constraints_json AS constraints FROM missions m JOIN mission_brief_versions b ON b.mission_id=m.id WHERE m.title='Weekly digest' AND m.id!=?").get(described) as { id: string; intent: string; criteria: string; constraints: string };
  expect(seeded.intent).toBe("Write the weekly digest of support tickets");
  expect(seeded.criteria).toContain("digest written");
  expect(seeded.constraints).toContain(described); // the brief names its source

  // Repeat this opens the schedule editor for the chosen mission's play.
  await page.goto(`${governor.url}/w/ws-today/today`);
  await page.getByRole("button", { name: "Repeat this", exact: true }).click();
  await shot(page, "today-repeat-list");
  await page.getByRole("region", { name: "Choose a mission to repeat" }).getByRole("button", { name: "Repeat Auth sweep" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/ws-today/schedules\\?repeat=${fromPlay}$`));
});

test("landing rule: Today when nothing is active or the queue is not empty, Live when work is active and nothing waits", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const w = await world(page, governor);
  const { brain, actor } = w;
  const s = brain.store; const org = actor.organizationId; const now = Date.now();
  await page.goto(governor.url);
  await expect(page).toHaveURL(/\/w\/ws-today\/today$/);

  const digest = `sha256:${"c".repeat(64)}`;
  s.control.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, source_documents_json, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(`sha256:${"d".repeat(64)}`, org, "seed", `sha256:${"d".repeat(64)}`, "[]", JSON.stringify({ manifest: { documents: [] } }), now);
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
    VALUES ('job-today',?,?,?,?, 'step-respond','running',?, '{}', ?, 'read', ?, ?, ?)`)
    .run(org, "ws-today", "today-seed-1", "run-today", `sha256:${"d".repeat(64)}`, digest, now, now, now + 3_600_000);
  await page.goto(governor.url);
  await expect(page).toHaveURL(/\/w\/ws-today\/live/);

  // A deep link is never overridden, even while the queue is non-empty.
  s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-today-1', ?, 'ws-today', ?, ?, ?, 'pending', ?, ?)`)
    .run(org, actor.actorId, `sha256:${"c".repeat(64)}`, JSON.stringify({ organizationId: org, workspaceId: "ws-today", operation: "fixture.publish", target: { targetId: "t", environmentId: "prod" } }), now + 3_600_000, now);
  await page.goto(governor.url);
  await expect(page).toHaveURL(/\/w\/ws-today\/today$/);
  await page.goto(`${governor.url}/w/ws-today/logs`);
  await expect(page).toHaveURL(/\/w\/ws-today\/logs/);
});
