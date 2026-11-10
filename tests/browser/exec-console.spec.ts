import { casFilePath } from "../../apps/governor/src/modules/artifacts/index";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect } from "./fixtures";

// Acceptance flow (plan §7, exec-console): three simultaneously running agents,
// switching between them without state loss, a tool call expanded to its
// sanitized arguments/stdout/exit status, an output diff, a steering message
// on a steer-capable session, and the work item followed to its verification —
// all through the real store. Seeds write to the SOURCE logs (workspace
// sessions/events, control attempt_events); the read path projects them
// on read, and the spec asserts exactly that (no maintenance tick first).
test("live console: three concurrent sessions, tool inspection, output diff, steer, verification", async ({ page, governor }) => {
  test.setTimeout(180_000);
  await page.goto(governor.url);
  await expect(page.getByRole("heading", { name: "Set up Keyrus Brain" })).toBeVisible();
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Console organization");
  await page.getByLabel(/^Email/).fill("console@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  // Signed in; the workspace is created below through the real store (the
  // first-launch card would otherwise ask for it through the same API).
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible({ timeout: 15_000 });

  const cookies = await page.context().cookies();
  const brain = governor.app.brain;
  const resolved = await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  const actor = resolved.actor;
  const now = Date.now();
  brain.createWorkspace(actor, { workspaceId: "ws-console", slug: "console" });
  const s = brain.store;
  const org = actor.organizationId;
  const ws = s.workspaceDb("ws-console", org);

  // Config release the job can pin (control DB FK).
  const releaseDigest = `sha256:${"c".repeat(64)}`;
  s.control.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, source_documents_json, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(releaseDigest, org, "seed", `sha256:${"d".repeat(64)}`, "[]", JSON.stringify({ manifest: { documents: [] } }), now);

  // Runner + job + attempt chain (control DB), so attempt events correlate.
  s.control.prepare("INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity, last_heartbeat_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("runner-console", org, "default", `sha256:${"1".repeat(64)}`, "enabled", "healthy", releaseDigest, 1000, 1024, 1024, 1, now);
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
    VALUES ('job-console',?,?,?,?, 'step-respond','running',?, '{}', ?, 'read', ?, ?, ?)`)
    .run(org, "ws-console", "console-seed-1", "run-console", releaseDigest, `sha256:${"e".repeat(64)}`, now, now, now + 3_600_000);
  s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms, last_event_seq)
    VALUES ('att-console','job-console','runner-console',1,1,'lease-console',1,'running',?, ?, ?)`)
    .run(now + 3_600_000, now + 3_600_000, 3);

  // Work item chain (workspace DB): objective → plan version → work item.
  ws.prepare("INSERT INTO missions(id, title, intent, success_criteria_json, owner_id, created_at_ms, updated_at_ms) VALUES ('obj-console','Ship the console','Ship it','[]',?, ?, ?)")
    .run(actor.actorId, now, now);
  ws.prepare("INSERT INTO plan_versions(id, mission_id, revision, digest, state, origin, created_by, tasks_json, created_at_ms) VALUES ('pv-console','obj-console',1,?, 'confirmed','manual',?,'[]',?)")
    .run(`sha256:${"2".repeat(64)}`, actor.actorId, now);
  ws.prepare(`INSERT INTO work_items(id, mission_id, plan_version_id, plan_task_id, title, state, criteria_json, next_action, created_at_ms, updated_at_ms)
    VALUES ('wi-console','obj-console','pv-console','task-1','Produce the deployment dossier','in-progress','[]','run', ?, ?)`)
    .run(now, now);
  ws.prepare("INSERT INTO execution_links(mission_id, work_item_id, run_id, job_id, attempt_id, session_id, created_at_ms) VALUES ('obj-console','wi-console','run-console','job-console','att-console','ses-report',?)")
    .run(now);

  // Three "simultaneously running" sessions: two steer-capable, one not.
  const ADAPTER = `sha256:${"0".repeat(64)}`;
  const insertSession = ws.prepare(`INSERT INTO sessions(id, job_id, attempt_id, mode, work_item_id, agent_id, task, engine_id, adapter_digest, engine_features, state, root_session_id, worktree_id, created_by, created_at_ms, updated_at_ms)
    VALUES (?,?,?, 'managed', ?, 'agent-review', ?, 'fixture', ?, ?, 'running', ?, 'wt-console', 'runner', ?, ?)`);
  insertSession.run("ses-plan", null, null, null, "Summarize the quarterly plan", ADAPTER, '["sessions","steer"]', "ses-plan", now, now);
  insertSession.run("ses-triage", null, null, null, "Triage the incident queue", ADAPTER, '["sessions","steer"]', "ses-triage", now, now);
  insertSession.run("ses-report", "job-console", "att-console", "wi-console", "Produce the deployment dossier", ADAPTER, '["sessions"]', "ses-report", now, now);

  // Source log 1: workspace.events — agent messages per session.
  const insertWsEvent = ws.prepare(`INSERT INTO events(event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?)`);
  const DIGEST = `sha256:${"a".repeat(64)}`;
  insertWsEvent.run("evt-plan-1", "session", "ses-plan", 1, "text", JSON.stringify({ sessionId: "ses-plan", text: "Plan review notes: three risks accepted.", channel: "assistant", provisional: true }), DIGEST, now);
  insertWsEvent.run("evt-triage-1", "session", "ses-triage", 1, "text", JSON.stringify({ sessionId: "ses-triage", text: "Triage: two incidents need owners.", channel: "assistant", provisional: true }), DIGEST, now);

  // Source log 2: attempt_events — one tool invocation (proposed + result) with
  // sanitized arguments, stdout artifact and exit status. The schema file owns
  // the table; the seed writes the same shape a runner batch would.
  const insertAttemptEvent = s.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)");
  insertAttemptEvent.run("att-console", 1, JSON.stringify({
    kind: "engine",
    payload: { contractVersion: "brain.engine-event/v1", eventId: "evt-att-1", sessionId: "ses-report", attemptId: "att-console", sequence: 1, occurredAt: new Date(now).toISOString(), kind: "text",
      payload: { text: "Compiling the deployment dossier.", channel: "assistant", provisional: true } },
  }));
  insertAttemptEvent.run("att-console", 2, JSON.stringify({
    kind: "engine",
    payload: { contractVersion: "brain.engine-event/v1", eventId: "evt-att-2", sessionId: "ses-report", attemptId: "att-console", sequence: 2, occurredAt: new Date(now + 1_000).toISOString(), kind: "tool.proposed",
      payload: { proposalId: "prop-dossier", tool: { id: "shell", digest: `sha256:${"b".repeat(64)}` }, input: { command: "make dossier", cwd: "/workspace" }, target: { targetId: "local-runner", environmentId: "managed" }, inputDigest: `sha256:${"3".repeat(64)}` } },
  }));
  const stdoutV1 = "# Deployment dossier\n\nDraft section: rollout steps pending.";
  const stdoutV2 = "# Deployment dossier\n\nDraft section: rollout steps approved by verification.";
  const digestOf = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const digestV1 = digestOf(stdoutV1);
  const digestV2 = digestOf(stdoutV2);
  insertAttemptEvent.run("att-console", 3, JSON.stringify({
    kind: "engine",
    payload: { contractVersion: "brain.engine-event/v1", eventId: "evt-att-3", sessionId: "ses-report", attemptId: "att-console", sequence: 3, occurredAt: new Date(now + 2_000).toISOString(), kind: "tool.result",
      payload: { proposalId: "prop-dossier", invocationId: "inv-dossier",
        receipt: { invocationId: "inv-dossier", attemptId: "att-console", jobFence: 1, result: "succeeded", startedAt: new Date(now + 1_000).toISOString(), finishedAt: new Date(now + 1_800).toISOString(), exitCode: 0,
          stdout: { artifactId: "art-out-v1", digest: digestV1, bytes: Buffer.byteLength(stdoutV1), mediaType: "text/markdown", classification: "internal" }, stderr: { artifactId: "art-err", digest: `sha256:${"4".repeat(64)}`, bytes: 0, mediaType: "text/plain", classification: "internal" }, effects: [] } },
    },
  }));

  // Source log 3 support: artifacts — two versions of one output (CAS + rows +
  // job-scoped association) so history and diff have data.
  const writeCas = (digest: string, text: string) => {
    const path = casFilePath(brain.store, digest);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  };
  writeCas(digestV1, stdoutV1);
  writeCas(digestV2, stdoutV2);
  ws.prepare("INSERT INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES ('art-out-v1',?,?,'text/markdown','internal','verified',?)")
    .run(digestV1, Buffer.byteLength(stdoutV1), now);
  ws.prepare("INSERT INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES ('art-out-v2',?,?,'text/markdown','internal','verified',?)")
    .run(digestV2, Buffer.byteLength(stdoutV2), now + 5_000);
  const insertAssociation = s.control.prepare("INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms) VALUES (?,?,?,?,?,?,?,?)");
  insertAssociation.run("art-out-v1", org, "ws-console", digestV1, "job", "job-console", "internal", now);
  insertAssociation.run("art-out-v2", org, "ws-console", digestV2, "job", "job-console", "internal", now);
  // The same two artifacts as versions of the mission's named output "dossier".
  ws.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES ('output-dossier','obj-console','dossier',?)").run(now);
  ws.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('outver-1','output-dossier','wi-console',?,'draft',0,?)").run(digestV1, now);
  ws.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('outver-2','output-dossier','wi-console',?,'final',1,?)").run(digestV2, now + 5_000);

  // Independent verification for the bound work item's run. The manifests are
  // the full contract shapes (evidence.get returns them verbatim and the
  // EvidenceList composition reads configDigest, primitiveVersions, checks…),
  // exactly what the evidence service stores on a real submit.
  const bundleDigest = `sha256:${"5".repeat(64)}`;
  const check = { criterionId: "task-1", checkId: "dossier-complete", status: "passed", oracleDigest: `sha256:${"7".repeat(64)}`, artifacts: [], detail: "The dossier's rollout section is present and approved." };
  const bundle = {
    contractVersion: "brain.evidence/v1", bundleId: "bundle-console", organizationId: org, workspaceId: "ws-console",
    workflowRunId: "run-console", jobId: "job-console", attemptId: "att-console", jobFence: 1,
    sourceRevision: "seed", configDigest: releaseDigest, workflowDigest: `sha256:${"8".repeat(64)}`,
    primitiveVersions: {}, toolReleases: [],
    artifacts: [{ artifactId: "art-out-v2", digest: digestV2, bytes: Buffer.byteLength(stdoutV2), mediaType: "text/markdown", classification: "internal" }],
    checks: [check], approvalIds: [], effects: [], createdAt: new Date(now).toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?, ?)")
    .run(bundleDigest, "bundle-console", "job-console", "att-console", JSON.stringify(bundle), now);
  const verdict = {
    contractVersion: "brain.verdict/v1", bundleDigest, evaluatorAttemptId: "att-evaluator",
    evaluatorRelease: { id: "evaluator", digest: `sha256:${"9".repeat(64)}` }, independence: "L2",
    outcome: "verified", checks: [check], acceptedBy: "runner-console", createdAt: new Date(now).toISOString(),
  };
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-console',?, 'att-evaluator', ?, 'verified', ?, ?)")
    .run(bundleDigest, `sha256:${"6".repeat(64)}`, JSON.stringify(verdict), now);

  // (a) Projection-on-read: the console opens with no maintenance tick and all
  // three seeded sessions surface in the rail.
  await page.goto(`${governor.url}/w/ws-console/live`);
  const rail = page.getByTestId("console-rail");
  await expect(rail).toBeVisible();
  for (const sessionId of ["ses-plan", "ses-triage", "ses-report"]) {
    await expect(rail.locator(`[data-session-id="${sessionId}"]`)).toBeVisible({ timeout: 30_000 });
  }
  const streamRows = (s.control.prepare("SELECT COUNT(*) AS c FROM execution_stream WHERE workspace_id=?").get("ws-console") as { c: number }).c;
  expect(streamRows, "workspace and attempt events projected on read").toBeGreaterThan(0);

  // (b) Switch between concurrent sessions without state loss: each session
  // shows only its own transcript; the selection is carried in the URL.
  await expect(page.getByText("Plan review notes: three risks accepted.")).toBeVisible({ timeout: 30_000 });
  // The transcript reads as turns over a live connection.
  await expect(page.getByRole("log", { name: "Transcript of session ses-plan" }).getByText("Turn 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Live$/ })).toBeVisible();
  await rail.locator('[data-session-id="ses-triage"]').click();
  await expect(page).toHaveURL(/session=ses-triage/);
  await expect(page.getByText("Triage: two incidents need owners.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Plan review notes: three risks accepted.")).toBeHidden();
  await rail.locator('[data-session-id="ses-plan"]').click();
  await expect(page.getByText("Plan review notes: three risks accepted.")).toBeVisible({ timeout: 30_000 });

  // (c) Expand a tool call: identity, sanitized arguments, exit status — then
  // resolve its authorized stdout artifact ("Open tool result").
  await rail.locator('[data-session-id="ses-report"]').click();
  await expect(page).toHaveURL(/session=ses-report/);
  await expect(page.getByText("Compiling the deployment dossier.")).toBeVisible({ timeout: 30_000 });
  const toolRow = page.getByRole("button", { name: /Tool call · shell/ }).first();
  await toolRow.click();
  const inspection = page.getByText("Sanitized arguments").first();
  await expect(inspection).toBeVisible();
  await expect(page.getByText("make dossier", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Exit status").first()).toBeVisible();
  await page.getByRole("button", { name: "Open tool result" }).first().click();
  await expect(page.getByText("text/markdown", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Deployment dossier", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // (d) Open an output diff: the bound session's outputs list both versions;
  // the artifact page diffs them (its deep link carries left/right).
  await expect(page.getByTestId("console-inspection")).toBeVisible();
  const outputsLink = page.getByRole("link", { name: "Open in Outputs" });
  await expect(outputsLink).toBeVisible();
  const outputsHref = await outputsLink.getAttribute("href");
  expect(outputsHref).toContain("job=job-console");
  await page.goto(`${governor.url}/outputs/art-out-v2/compare?left=art-out-v1&right=art-out-v2`);
  await expect(page.getByText("rollout steps approved by verification", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // (d0) The Output Browser is a file explorer: ticking two files raises the
  // one selection bar, whose Compare hands off to the same diff route.
  await page.goto(`${governor.url}/w/ws-console/outputs?folder=all&view=list`);
  await page.getByRole("checkbox", { name: "Select art-out-v1.md" }).check({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: "Select art-out-v2.md" }).check();
  // Each file card says how long ago it was produced.
  await expect(page.getByTestId("output-file").first()).toContainText(/ago|just now|now/i);
  const selection = page.getByRole("region", { name: "Selection actions" });
  await expect(selection).toContainText("2 selected");
  // Bulk Save as knowledge uploads each ticked file as a document and reports the outcome once.
  await selection.getByRole("button", { name: "Save as knowledge", exact: true }).click();
  await expect(page.getByText(/Saved to knowledge 2 items\./)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: "Select art-out-v1.md" }).check();
  await page.getByRole("checkbox", { name: "Select art-out-v2.md" }).check();
  await expect(selection).toContainText("2 selected");
  await selection.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/\/outputs\/art-out-v[12]\/compare\?left=art-out-v[12]&right=art-out-v[12]$/);
  await expect(page.getByText("rollout steps approved by verification", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // (d') The named output lists its versions newest first, opens one with
  // ?v= and compares an earlier version with the latest beside provenance.
  await page.goto(`${governor.url}/outputs/output-dossier`);
  await expect(page.getByRole("heading", { name: "dossier", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Open Version 2", exact: true })).toHaveAttribute("data-selected", "true");
  await page.getByRole("button", { name: "Open Version 1", exact: true }).click();
  await expect(page).toHaveURL(/\/outputs\/output-dossier\?v=outver-1$/);
  await expect(page.getByRole("button", { name: "Open Version 1", exact: true })).toHaveAttribute("data-selected", "true");
  await expect(page.getByText("This output starts its own line", { exact: false })).toBeVisible();
  // The comparison picker defaults to the version just before the latest, which is Version 1 here.
  await page.getByRole("button", { name: "Compare versions", exact: true }).click();
  await expect(page).toHaveURL(/\/outputs\/output-dossier\/compare\?left=outver-1&right=outver-2$/);
  await expect(page.getByRole("heading", { name: "Version comparison", exact: true })).toBeVisible();
  await expect(page.getByText("rollout steps approved by verification", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Exit comparison", exact: true }).click();
  await expect(page).toHaveURL(/\/outputs\/output-dossier$/);

  // (e) Steer is feature-gated: the non-steering session hides the control;
  // the steer-capable session accepts a message and records session_controls.
  await page.goto(`${governor.url}/w/ws-console/live?session=ses-report`);
  await expect(rail.locator('[data-session-id="ses-report"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Steer/ })).toBeHidden();
  await page.goto(`${governor.url}/w/ws-console/live?session=ses-plan`);
  await expect(page.getByText("Plan review notes: three risks accepted.")).toBeVisible({ timeout: 30_000 });
  const steer = page.getByRole("button", { name: /^Steer/ });
  await expect(steer).toBeVisible();
  await steer.click();
  await page.getByLabel("Steering message").fill("Focus on the budget section next.");
  await page.getByRole("button", { name: "Send steering" }).click();
  // The steering message goes to the server as a session control, not into the
  // transcript; delivery to the runner is asserted at the integration level.
  const steerRows = (ws.prepare("SELECT COUNT(*) AS c FROM session_controls WHERE session_id='ses-plan' AND kind='session.steer'").get() as { c: number }).c;
  expect(steerRows, "steer control recorded for the runner to pick up").toBe(1);

  // A request for input surfaces inline in the transcript, with a reply that opens steering.
  insertWsEvent.run("evt-plan-ask", "session", "ses-plan", 2, "human.input.requested", JSON.stringify({ sessionId: "ses-plan", prompt: "Which quarter should I summarize?" }), DIGEST, Date.now());
  const ask = page.getByRole("note", { name: "The agent is waiting for input" });
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask.getByText("Which quarter should I summarize?")).toBeVisible();
  await ask.getByRole("button", { name: "Reply to the agent", exact: true }).click();
  await expect(page.getByLabel("Steering message")).toBeVisible();

  // New records while the reader is scrolled up are counted, not forced into view; Jump to latest follows again.
  for (let i = 1; i <= 60; i += 1) insertWsEvent.run(`evt-plan-line-${i}`, "session", "ses-plan", 2 + i, "text", JSON.stringify({ sessionId: "ses-plan", text: `Reading section ${i}.\n`, channel: "assistant" }), DIGEST, Date.now());
  const planTranscript = page.getByRole("log", { name: "Transcript of session ses-plan" });
  await expect(planTranscript.getByText("Reading section 60.")).toBeVisible({ timeout: 30_000 });
  await planTranscript.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  for (let i = 61; i <= 63; i += 1) insertWsEvent.run(`evt-plan-line-${i}`, "session", "ses-plan", 2 + i, "text", JSON.stringify({ sessionId: "ses-plan", text: `Reading section ${i}.\n`, channel: "assistant" }), DIGEST, Date.now());
  const jump = page.getByRole("button", { name: /^Jump to latest \(3\)$/ });
  await expect(jump).toBeVisible({ timeout: 30_000 });
  await jump.click();
  await expect(jump).toBeHidden();
  await expect(planTranscript.getByText("Reading section 63.")).toBeInViewport();

  // Attach context is a mission message about the bound work item.
  await page.goto(`${governor.url}/w/ws-console/live?session=ses-report`);
  await expect(page.getByText("Compiling the deployment dossier.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Attach context" }).click();
  await page.getByLabel("Context for the work item and session").fill("Use the approved rollout section verbatim.");
  await page.getByRole("button", { name: "Attach to work item" }).click();
  await expect.poll(() => (ws.prepare("SELECT COUNT(*) AS c FROM mission_messages m JOIN sessions s ON s.work_item_id=m.work_item_id WHERE s.id='ses-report'").get() as { c: number }).c, { message: "attach context recorded as a mission message" }).toBe(1);

  // (f) Follow the work item to its verification: the inspection pane binds the
  // run's evidence bundle and the independent verdict.
  await expect(page.getByTestId("console-inspection").getByText("Verified", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // (g) Back/forward restores the selected session and the execution filters.
  await page.goto(`${governor.url}/w/ws-console/live?session=ses-triage&severity=error`);
  await expect(page).toHaveURL(/session=ses-triage/);
  await page.goto(`${governor.url}/w/ws-console/missions`);
  await page.goBack();
  await expect(page).toHaveURL(/session=ses-triage/);
  await expect(page).toHaveURL(/severity=error/);
  await expect(page.getByRole("button", { name: "Error" })).toHaveAttribute("aria-pressed", "true");

  // (h) The mission cockpit (T60): its console holds only this mission's
  // sessions, the team rail follows one member, and the composer messages that
  // member and adds the message to the brief as a constraint.
  ws.prepare("UPDATE plan_versions SET team_json=? WHERE id='pv-console'").run(JSON.stringify([{ memberId: "writer", role: "Dossier writer", agentId: "writer-agent", engine: "pi" }]));
  ws.prepare("UPDATE work_items SET assignment_json=? WHERE id='wi-console'").run(JSON.stringify({ kind: "agent", id: "writer", role: "specialist" }));
  ws.prepare("UPDATE missions SET active_plan_version_id='pv-console' WHERE id='obj-console'").run();
  ws.prepare("INSERT OR IGNORE INTO mission_brief_versions(mission_id,version,intent,constraints_json,change,created_by,created_at_ms) VALUES ('obj-console',1,'Ship it','[]','created',?,?)").run(actor.actorId, now);
  await page.goto(`${governor.url}/missions/obj-console/live`);
  await expect(rail.locator('[data-session-id="ses-report"]')).toBeVisible({ timeout: 30_000 });
  await expect(rail.locator('[data-session-id="ses-plan"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Follow Dossier writer (writer)", exact: true }).click();
  await expect(page).toHaveURL(/member=writer/);
  await expect(rail.locator('[data-session-id="ses-report"]')).toBeVisible();
  await page.getByRole("button", { name: "Message the mission", exact: true }).click();
  await page.getByLabel("Recipient", { exact: true }).click();
  await page.getByRole("option", { name: "Dossier writer (writer)", exact: true }).click();
  await page.getByRole("textbox", { name: /^Message/ }).fill("Keep the rollout section verbatim.");
  await page.getByRole("dialog").getByLabel("Also add to the brief as a constraint").check();
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => ws.prepare("SELECT recipient_kind, recipient_member_id FROM mission_messages WHERE body=?").get("Keep the rollout section verbatim.")).toEqual({ recipient_kind: "member", recipient_member_id: "writer" });
  await expect.poll(() => (ws.prepare("SELECT constraints_json FROM mission_brief_versions WHERE mission_id='obj-console' ORDER BY version DESC LIMIT 1").get() as { constraints_json: string }).constraints_json).toBe(JSON.stringify(["Keep the rollout section verbatim."]));

  // Split compare: two of the mission's sessions side by side, each its own transcript.
  ws.prepare("UPDATE sessions SET work_item_id='wi-console' WHERE id='ses-triage'").run();
  await page.goto(`${governor.url}/missions/obj-console/live?compare=ses-report,ses-triage`);
  const transcripts = page.getByRole("region", { name: /^Transcript of / });
  await expect(transcripts).toHaveCount(2, { timeout: 30_000 });
  await expect(transcripts.first().getByText("Compiling the deployment dossier.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close comparison", exact: true }).click();
  await expect(transcripts).toHaveCount(0);
  ws.prepare("UPDATE sessions SET work_item_id=NULL WHERE id='ses-triage'").run();

  // The workspace console filters to one mission; the header bell opens the
  // attention drawer instead of an inbox route.
  await page.goto(`${governor.url}/w/ws-console/live?mission=obj-console`);
  await expect(rail.locator('[data-session-id="ses-report"]')).toBeVisible({ timeout: 30_000 });
  await expect(rail.locator('[data-session-id="ses-plan"]')).toHaveCount(0);
  await page.getByRole("button", { name: /^Needs you:/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Recent notifications", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // (i) The mission's Outputs tab groups named outputs by plan task and opens
  // the named output; Watch is a toggle with the viewer's state.
  await page.goto(`${governor.url}/missions/obj-console/outputs`);
  const producing = page.getByRole("region", { name: "Outputs of Produce the deployment dossier" });
  await producing.getByRole("button", { name: "Open output dossier", exact: true }).click();
  await expect(page).toHaveURL(/\/outputs\/output-dossier$/);
  await expect(page.getByRole("heading", { name: "dossier", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.goto(`${governor.url}/missions/obj-console/live`);
  await page.getByRole("button", { name: "Watch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unwatch", exact: true })).toHaveAttribute("aria-pressed", "true");

  // (j) Attention spans workspaces: from ws-console the bell opens another
  // workspace's plan proposal, and the mission page switches to that workspace.
  brain.createWorkspace(actor, { workspaceId: "ws-other", slug: "other" });
  const other = s.workspaceDb("ws-other", org);
  other.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-other','Other workspace mission','Elsewhere','[]',?,?,?)").run(actor.actorId, now, now);
  other.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('pv-other','obj-other',1,?,'proposed','agent',?,'[]',?)").run(`sha256:${"9".repeat(64)}`, actor.actorId, now);
  await page.goto(`${governor.url}/w/ws-console/missions`);
  await page.getByRole("button", { name: /^Needs you:/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Plan proposal for Other workspace mission. Open", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/obj-other\/plan\?w=ws-other&proposal=pv-other$/);
  await expect(page.getByRole("heading", { name: "Other workspace mission", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Proposal: revision 1", { exact: false })).toBeVisible();
});
