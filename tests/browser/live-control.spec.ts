import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// Watching and steering a running task as a first-time user: one plain sentence about what the agent
// is doing, how far it is against the plan's estimate, and Pause / Steer / Stop, where a steer is first
// written into the mission brief (so it survives a lost delivery) and only then sent to the agent.
const SHOTS = process.env["BRAIN_SHOT_DIR"];
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

test("live: doing-now sentence, ETA band, Pause, Steer recorded in the brief, Stop", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Live organization");
  await page.getByLabel(/^Email/).fill("live@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible({ timeout: 15_000 });

  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor = (await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }))).actor;
  const now = Date.now();
  brain.createWorkspace(actor, { workspaceId: "ws-live", slug: "live" });
  const s = brain.store;
  const org = actor.organizationId;
  const ws = s.workspaceDb("ws-live", org);

  const releaseDigest = `sha256:${"c".repeat(64)}`;
  s.control.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, source_documents_json, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(releaseDigest, org, "seed", `sha256:${"d".repeat(64)}`, "[]", JSON.stringify({ manifest: { documents: [] } }), now);
  s.control.prepare("INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity, last_heartbeat_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("runner-live", org, "default", `sha256:${"1".repeat(64)}`, "enabled", "healthy", releaseDigest, 1000, 1024, 1024, 1, now);
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
    VALUES ('job-live',?,?,?,?, 'step-respond','running',?, '{}', ?, 'read', ?, ?, ?)`)
    .run(org, "ws-live", "live-seed-1", "run-live", releaseDigest, `sha256:${"e".repeat(64)}`, now, now, now + 3_600_000);
  s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms, last_event_seq)
    VALUES ('att-live','job-live','runner-live',1,1,'lease-live',1,'running',?, ?, ?)`)
    .run(now + 3_600_000, now + 3_600_000, 5);

  // A mission with a confirmed plan whose one task carries a 10 minute estimate, worked on by a session that started 4 minutes ago.
  const tasks = [{ id: "task-1", title: "Research the market", criteria: ["Names three competitors"], dependsOn: [], estimatedMinutes: 10 }];
  ws.prepare("INSERT INTO missions(id, title, intent, success_criteria_json, owner_id, active_plan_version_id, created_at_ms, updated_at_ms) VALUES ('mis-live','Market scan','Scan the market','[\"A scan exists\"]',?,'pv-live',?,?)")
    .run(actor.actorId, now, now);
  ws.prepare("INSERT INTO plan_versions(id, mission_id, revision, digest, state, origin, created_by, tasks_json, created_at_ms) VALUES ('pv-live','mis-live',1,?, 'confirmed','manual',?,?,?)")
    .run(`sha256:${"2".repeat(64)}`, actor.actorId, JSON.stringify(tasks), now);
  ws.prepare(`INSERT INTO work_items(id, mission_id, plan_version_id, plan_task_id, title, state, criteria_json, next_action, created_at_ms, updated_at_ms)
    VALUES ('wi-live','mis-live','pv-live','task-1','Research the market','in-progress','["Names three competitors"]','run', ?, ?)`).run(now, now);
  ws.prepare("INSERT INTO execution_links(mission_id, work_item_id, run_id, job_id, attempt_id, session_id, created_at_ms) VALUES ('mis-live','wi-live','run-live','job-live','att-live','ses-live',?)").run(now);
  const started = now - 4 * 60_000;
  ws.prepare(`INSERT INTO sessions(id, job_id, attempt_id, mode, work_item_id, agent_id, task, engine_id, adapter_digest, engine_features, state, root_session_id, worktree_id, created_by, created_at_ms, updated_at_ms)
    VALUES ('ses-live','job-live','att-live','managed','wi-live','task-worker','Research the market','fixture',?,'["sessions"]','running','ses-live','wt-live','runner',?,?)`)
    .run(`sha256:${"0".repeat(64)}`, started, now);

  // Structured events: two finished document reads and a third still running.
  const insert = s.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)");
  const engine = (seq: number, kind: string, payload: unknown) => JSON.stringify({ kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: `evt-live-${seq}`, sessionId: "ses-live", attemptId: "att-live", sequence: seq, occurredAt: new Date(started + seq * 1000).toISOString(), kind, payload } });
  const read = (seq: number, id: string, done: boolean) => {
    insert.run("att-live", seq, engine(seq, "tool.proposed", { proposalId: `prop-${id}`, tool: { id: "documents.read", digest: `sha256:${"b".repeat(64)}` }, input: { documentId: id }, target: { targetId: "local-runner", environmentId: "managed" }, inputDigest: `sha256:${"3".repeat(64)}` }));
    if (done) insert.run("att-live", seq + 1, engine(seq + 1, "tool.result", { proposalId: `prop-${id}`, invocationId: `inv-${id}`, receipt: { invocationId: `inv-${id}`, attemptId: "att-live", jobFence: 1, result: "succeeded", startedAt: new Date(started + seq * 1000).toISOString(), finishedAt: new Date(started + seq * 1000 + 500).toISOString(), exitCode: 0, effects: [] } }));
  };
  read(1, "doc-a", true);
  read(3, "doc-b", true);
  read(5, "doc-c", false);

  // 1. Live: the sentence is built from the events, the band from the plan's estimate.
  await page.goto(`${governor.url}/w/ws-live/live?session=ses-live`);
  const now_ = page.getByTestId("console-now");
  await expect(now_).toContainText("Reading 3 sources", { timeout: 30_000 });
  const band = now_.getByTestId("eta-band");
  await expect(band).toHaveAttribute("data-kind", "within");
  await expect(band).toContainText(/4 min of about 10 min/);
  await expect(page.getByTestId("rail-doing-now").first()).toContainText("Working on it now.");
  await shot(page, "1-live");

  // 2. Steer is offered although this agent cannot be redirected: the instruction is saved in the brief.
  await page.getByRole("button", { name: /^Steer/ }).click();
  await page.getByLabel("Steering message").fill("Focus on European competitors only");
  await expect(page.getByText("This agent cannot be redirected while it works, so it applies from its next task.")).toBeVisible();
  await shot(page, "2-steer");
  await page.getByRole("button", { name: "Send steering" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved to the mission brief/ })).toContainText("applies from its next task");
  const constraintsOf = () => (JSON.parse((ws.prepare("SELECT constraints_json FROM mission_brief_versions WHERE mission_id='mis-live' ORDER BY version DESC LIMIT 1").get() as { constraints_json: string }).constraints_json) as string[]);
  expect(constraintsOf().at(-1)).toMatch(/^Steering \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\): Focus on European competitors only$/);
  expect((ws.prepare("SELECT COUNT(*) AS c FROM session_controls").get() as { c: number }).c).toBe(0);
  expect((ws.prepare("SELECT created_by FROM mission_brief_versions WHERE mission_id='mis-live' ORDER BY version DESC LIMIT 1").get() as { created_by: string }).created_by).toBe(actor.actorId);

  // 3. An engine that can be redirected gets the brief record first and the delivery second.
  ws.prepare("UPDATE sessions SET engine_features='[\"sessions\",\"steer\"]' WHERE id='ses-live'").run();
  await page.reload();
  await expect(page.getByTestId("console-now")).toContainText("Reading 3 sources", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Steer/ }).click();
  await page.getByLabel("Steering message").fill("Keep it under two pages");
  await page.getByRole("button", { name: "Send steering" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved to the mission brief and sent to the agent/ })).toBeVisible();
  expect(constraintsOf().filter((entry) => entry.startsWith("Steering"))).toHaveLength(2);
  const control = ws.prepare("SELECT kind, payload, created_at_ms FROM session_controls").all() as Array<{ kind: string; payload: string; created_at_ms: number }>;
  expect(control).toHaveLength(1);
  expect(control[0]!.kind).toBe("session.steer");
  expect(JSON.parse(control[0]!.payload).message).toBe("Keep it under two pages");
  const briefAt = (ws.prepare("SELECT created_at_ms FROM mission_brief_versions WHERE mission_id='mis-live' ORDER BY version DESC LIMIT 1").get() as { created_at_ms: number }).created_at_ms;
  expect(briefAt).toBeLessThanOrEqual(control[0]!.created_at_ms);

  // 4. Pause pauses the mission; Resume brings it back.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Mission paused/ })).toBeVisible();
  expect((ws.prepare("SELECT state FROM missions WHERE id='mis-live'").get() as { state: string }).state).toBe("paused");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect((ws.prepare("SELECT state FROM missions WHERE id='mis-live'").get() as { state: string }).state).toBe("active");

  // 5. The task row on the mission's Plan tab says the same in words, with the band.
  await page.goto(`${governor.url}/missions/mis-live/plan?w=ws-live`);
  const row = page.getByTestId("task-now").first();
  await expect(row).toContainText("Working on it now.", { timeout: 30_000 });
  await expect(row.getByTestId("eta-band")).toContainText(/of about 10 min/);
  await shot(page, "3-task-row");

  // 6. Stop goes through the command funnel with a named reason.
  await page.goto(`${governor.url}/w/ws-live/live?session=ses-live`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByLabel("Stop reason").fill("Wrong direction");
  await page.getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS c FROM session_controls WHERE kind='session.stop'").get() as { c: number }).c).toBe(1);
  expect(errors).toEqual([]);
});
