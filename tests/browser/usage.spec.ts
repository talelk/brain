import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";

const DIGEST = `sha256:${"a".repeat(64)}`;
type Offer = { jobId: string; attemptId: string };

test("usage: tokens and dollars at run, task, mission and workspace level; token ceiling pause and raise; plan estimates; spend cap (#76 #77 #78 #54 #55)", async ({ page, governor }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Usage organization");
  await page.getByLabel(/^Email/).fill("usage@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-usage", slug: "usage" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const ws = { ...actor, workspaceId: "ws-usage", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-usage") };
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-usage", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;

  // A local-model mission: no dollar budget, a 1,000 token ceiling, two tasks (one with plan estimates).
  const missionId = (await command("mission.create", "u-create", { title: "Local research", intent: "Research locally", successCriteria: ["done"], budget: { maxTokens: 1000, attemptReserveTokens: 100, memberCap: 3 } })).resourceId ?? "";
  const planId = (await command("plan.propose", "u-plan", { missionId, origin: "manual", tasks: [
    { id: "a", title: "Gather sources", criteria: ["gathered"], dependsOn: [], estimatedMinutes: 10, maxMicroUsd: 300_000 },
    { id: "b", title: "Write the summary", criteria: ["written"], dependsOn: [] },
  ] })).resourceId ?? "";

  // The plan before confirming: estimates, unknowns and the ceiling the Governor enforces.
  await page.goto(`${governor.url}/missions/${missionId}/plan?w=ws-usage&proposal=${planId}`);
  const estimate = page.getByTestId("plan-estimate");
  await expect(estimate).toBeVisible({ timeout: 15_000 });
  await expect(estimate.getByTestId("estimate-time")).toContainText("about 10 min across 1 task (1 task without an estimate not included)");
  await expect(estimate.getByTestId("estimate-cost")).toContainText("up to $0.30 across 1 task");
  await expect(estimate.getByTestId("estimate-ceiling")).toContainText("1k tokens");
  await estimate.screenshot({ path: testInfo.outputPath("plan-estimate.png") });

  await command("plan.confirm", "u-confirm", { planVersionId: planId }, 1);
  const db = brain.store.workspaceDb("ws-usage", actor.organizationId);
  const items = db.prepare("SELECT id, plan_task_id FROM work_items WHERE mission_id=? ORDER BY plan_task_id").all(missionId) as Array<{ id: string; plan_task_id: string }>;
  const s = brain.store;
  const now = s.now();
  const placement = JSON.stringify({ group: "fixture-tools", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], isolation: "ephemeral-container", resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 } });
  for (const item of items) {
    brain.missions.linkExecution(actor, "ws-usage", item.id, `run-u-${item.plan_task_id}`);
    db.prepare("UPDATE execution_links SET job_id=? WHERE work_item_id=?").run(`job-u-${item.plan_task_id}`, item.id);
    s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
      VALUES (?,?,?,?,?, 'echo', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', 0, ?, ?, ?)`).run(`job-u-${item.plan_task_id}`, actor.organizationId, "ws-usage", `key-u-${item.plan_task_id}`, `run-u-${item.plan_task_id}`, release.digest, placement, DIGEST, now, now, now + 3_600_000);
    s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(`job-u-${item.plan_task_id}`, "dispatch", "{}");
  }
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES ('runner-u', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, 4)`).run(actor.organizationId, DIGEST, now);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-u', ?, 1, 'test', ?, ?)").run(cap, now, now + 3_600_000);
  }
  const runner = { runnerId: "runner-u", epoch: 1, organizationId: actor.organizationId };

  // First attempt runs on a local model: 900 in, 50 out, 30 read from cache, zero dollars.
  const first = brain.jobProtocol.claim(runner, "req-u-1") as unknown as Offer;
  expect(first.jobId).toBe("job-u-a");
  s.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(first.attemptId, 1, JSON.stringify({ kind: "engine", payload: { kind: "usage", payload: { usageId: "u1", inputTokens: 900, outputTokens: 50, cachedInputTokens: 30, microUsd: 0, accounting: "final-total", estimated: false } } }));
  s.control.prepare("UPDATE job_attempts SET state='succeeded' WHERE id=?").run(first.attemptId);
  brain.jobProtocol.releaseReservation(first.attemptId);

  // A readable result for that task, so its Result card exists.
  const text = "# Sources\n\nThree sources gathered.\n";
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const path = casFilePath(brain.store, digest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  db.prepare("INSERT INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES ('art-u',?,?,'text/markdown','internal','verified',?)").run(digest, Buffer.byteLength(text), now);
  s.control.prepare("INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms) VALUES ('art-u',?,?,?,?,?,?,?)").run(actor.organizationId, "ws-usage", digest, "job", "job-u-a", "internal", now);
  db.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES ('output-u',?,'sources',?)").run(missionId, now);
  db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('outver-u','output-u',?,?,'final',1,?)").run(items[0]!.id, digest, now);

  // Mission level: tokens lead, dollars honestly zero, the ceiling meter shows the share used.
  await page.goto(`${governor.url}/missions/${missionId}/live?w=ws-usage`);
  const mission = page.getByTestId("mission-usage");
  await expect(mission.getByTestId("usage-tokens")).toHaveText("980 tokens", { timeout: 15_000 });
  await expect(mission.getByTestId("usage-dollars")).toContainText("$0 (local models report no cost)");
  await expect(mission.getByText("900 in · 50 out · 30 read from cache (3% of tokens)")).toBeVisible();
  await expect(mission.getByRole("progressbar", { name: "Mission token ceiling" })).toBeVisible();
  await expect(mission.getByText("Settled 980")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mission.screenshot({ path: testInfo.outputPath("mission-usage.png") });

  // The next attempt would pass the ceiling: admission refuses and the mission pauses with the budget reason.
  expect(brain.jobProtocol.claim(runner, "req-u-2")).toBeNull();
  await page.reload();
  await expect(page.getByText(/paused because a spending or token limit was reached/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("mission-paused.png"), fullPage: true });
  await page.getByRole("button", { name: "Raise limits" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Token ceiling (tokens)")).toHaveValue("1000");
  await dialog.getByLabel("Token ceiling (tokens)").fill("5000");
  await dialog.screenshot({ path: testInfo.outputPath("raise-dialog.png") });
  await dialog.getByRole("button", { name: "Save and resume" }).click();
  await expect(page.getByRole("button", { name: "Change limits" })).toBeVisible({ timeout: 15_000 });
  await expect(mission.getByRole("progressbar", { name: "Mission token ceiling" })).toHaveAttribute("aria-valuemax", "5000");
  expect((db.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string }).state).toBe("active");
  expect((brain.jobProtocol.claim(runner, "req-u-3") as unknown as Offer).jobId).toBe("job-u-b");

  // Task level: the Result card carries the task's tokens and cost, beside the plan's estimate.
  await page.goto(`${governor.url}/w/ws-usage/outputs`);
  const card = page.getByTestId("output-task").filter({ hasText: "Result: Gather sources" }).getByTestId("task-usage");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("usage-tokens")).toHaveText("980 tokens");
  await expect(card.getByTestId("task-usage-estimate")).toContainText("up to $0.30; actual $0");
  await card.screenshot({ path: testInfo.outputPath("task-usage.png") });

  // Run level: the run's attempts with tokens, and the attempt in flight shown as such.
  await page.goto(`${governor.url}/runs/job-u-a`);
  const run = page.getByTestId("run-usage");
  await expect(run.getByTestId("usage-tokens")).toHaveText("980 tokens", { timeout: 15_000 });
  await expect(run.getByTestId("run-usage-attempt")).toContainText("Attempt 1: 980 tokens");
  await run.screenshot({ path: testInfo.outputPath("run-usage.png") });

  // Workspace level on Missions, with the spend cap: set it, see it as a meter.
  await page.goto(`${governor.url}/w/ws-usage/missions`);
  const workspace = page.getByTestId("workspace-usage");
  await expect(workspace.getByTestId("usage-tokens")).toHaveText("980 tokens", { timeout: 15_000 });
  await expect(workspace.getByTestId("spend-cap")).toContainText("No daily spend cap");
  await workspace.getByRole("button", { name: "Spend cap" }).click();
  await page.getByRole("dialog").getByLabel("Daily cap (US dollars)").fill("2");
  await page.getByRole("dialog").getByRole("button", { name: "Save cap" }).click();
  await expect(workspace.getByRole("progressbar", { name: "Daily spend cap (last 24 hours)" })).toHaveAttribute("aria-valuemax", "2000000", { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workspace-usage.png"), fullPage: true });
  expect(errors).toEqual([]);
});
