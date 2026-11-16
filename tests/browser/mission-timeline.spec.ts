import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";

/**
 * The mission timeline and the run page's Tool calls tab (spec #90, stories 51 to 53), walked as a first-time person: start a mission in the
 * real form, confirm its plan, accept a decision and message a team member on their own screens, let the runners finish, then read the
 * whole story on one timeline, narrow it by kind and by member, follow an entry to its run and read that run's tool calls without
 * leaving the mission. The runners and the fixture engine are real; the one direct write is the runner's tool-call record (the fixture
 * engine of this world calls no tools, so two calls are recorded the way event ingestion would).
 */
test("a person reads one timeline of the mission, filters it and follows an entry to the run's tool calls", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "timeline");
  brain.createWorkspace(actor, { workspaceId: "ws-timeline", slug: "timeline" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const sessions = await enrollRunners(governor, actor, "timeline");
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-timeline")).actor;
  const ws = brain.store.workspaceDb("ws-timeline", actor.organizationId);

  // The mission starts in the New mission form.
  await page.goto(`${governor.url}/w/ws-timeline/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill("Stabilize the sign-in flow end to end");
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (ws.prepare("SELECT id FROM missions WHERE title LIKE ?").get("Stabilize the sign-in flow%") as { id: string }).id;

  // The planner's proposal (the "ask Brain" step), with one team member, then the person confirms it in the Plan view.
  const key = `timeline-plan-${missionId}`;
  const { receipt } = await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-timeline", idempotencyKey: key,
    payload: {
      missionId, origin: "manual", summary: "Inspect the sign-in flow", team: [{ memberId: "worker", role: "Sign-in analyst", agentId: "task-worker", engine: "fixture" }],
      tasks: [{ id: "inspect", title: "Inspect the sign-in flow", criteria: ["structure", "safety"], dependsOn: [], workflowId: "operations-triage", criterionIds: ["c1"] }],
    },
  } as never, key);
  expect(receipt.accepted).toBe(true);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => ws.prepare("SELECT COUNT(*) AS n FROM work_items WHERE mission_id=?").get(missionId)).toEqual({ n: 1 });

  // A decision on the Brief tab and a message to the team member on the Live tab, both on their own screens.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/brief`);
  await page.getByRole("button", { name: "Accept a decision", exact: true }).click();
  await page.getByLabel(/^New decision/).fill("Check the session cookie before anything else");
  await page.getByRole("button", { name: "Accept decision", exact: true }).click();
  await expect(page.getByText("Check the session cookie before anything else").first()).toBeVisible();
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/live`);
  await page.getByRole("button", { name: "Message the mission", exact: true }).click();
  await page.getByLabel("Recipient", { exact: true }).click();
  await page.getByRole("option", { name: "Sign-in analyst (worker)", exact: true }).click();
  await page.getByRole("textbox", { name: /^Message/ }).fill("Start with the login redirect.");
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => ws.prepare("SELECT recipient_member_id FROM mission_messages WHERE body=?").get("Start with the login redirect.")).toEqual({ recipient_member_id: "worker" });

  // The runners finish the work and the Governor closes the mission on a verified verdict.
  await driveRuns(sessions, () => (ws.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string }).state === "closed", 150_000);
  const link = ws.prepare("SELECT run_id FROM execution_links WHERE mission_id=?").get(missionId) as { run_id: string };
  const attempt = brain.store.control.prepare("SELECT a.id AS attemptId FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=? ORDER BY a.attempt_no LIMIT 1").get(link.run_id) as { attemptId: string };
  const insertCall = brain.store.control.prepare("INSERT INTO tool_calls(attempt_id, proposal_id, organization_id, workspace_id, run_id, tool_id, proposed_at, failed, finished_at, failure_message) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const at = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
  insertCall.run(attempt.attemptId, "tc-1", actor.organizationId, "ws-timeline", link.run_id, "documents.read", at(0), 0, at(400), null);
  insertCall.run(attempt.attemptId, "tc-2", actor.organizationId, "ws-timeline", link.run_id, "web.fetch", at(900), 1, at(1200), "host example.com is not on this tool's allowlist");

  // The mission page offers the timeline under "More views".
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs`);
  const closedPanel = page.getByTestId("mission-signoff");
  await expect(closedPanel).toHaveAttribute("data-signed-by", "brain", { timeout: 30_000 });
  await expect(closedPanel.getByTestId("signoff-done")).toContainText("Verified by Brain from the tasks' independent checks. No person signed this mission off.");
  await expect(closedPanel).not.toContainText("signed off by a person");
  await page.getByRole("button", { name: "More views", exact: true }).click();
  await page.getByRole("menuitem", { name: "Timeline", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/timeline/);
  const timeline = page.getByTestId("mission-timeline");
  await expect(timeline).toBeVisible({ timeout: 30_000 });
  const entries = timeline.locator("[data-timeline-entry]");
  const kinds = async (): Promise<string[]> => [...new Set(await entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind") ?? "")))];
  await expect(timeline.getByText("Plan version 1 was proposed", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Plan version 1 was confirmed", { exact: true })).toBeVisible();
  await expect(timeline.getByText("A decision was accepted", { exact: true })).toBeVisible();
  await expect(timeline.getByText("A message was sent to Sign-in analyst", { exact: true })).toBeVisible();
  await expect(timeline.getByText("The independent check passed", { exact: true })).toBeVisible();
  // Nobody signed this mission off: the Governor verified it from the tasks' independent checks, and the timeline says so.
  await expect(timeline.getByText("Verified by Brain from the tasks' independent checks; no person signed off", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Signed off: the mission was verified")).toHaveCount(0);
  expect((await kinds()).sort()).toEqual(["decision", "message", "plan", "run", "verdict"]);
  // Oldest first: the plan is proposed before the mission is signed off.
  const order = await entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event")));
  expect(order.indexOf("plan.proposed")).toBeLessThan(order.indexOf("plan.confirmed"));
  expect(order.indexOf("plan.confirmed")).toBeLessThan(order.indexOf("verdict.mission"));
  const total = order.length;

  // Filtering by kind keeps only that kind; the address remembers it.
  await timeline.getByLabel("Kind", { exact: true }).click();
  await page.getByRole("option", { name: "Decision", exact: true }).click();
  await expect(page).toHaveURL(/kind=decision/);
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveText("A decision was accepted");
  await expect(timeline.locator("[data-timeline-count]")).toHaveText(`Showing 1 of ${total} entries`);
  // Filtering by team member keeps what names that member; both filters together find nothing here, and say so.
  await timeline.getByLabel("Kind", { exact: true }).click();
  await page.getByRole("option", { name: "Every kind", exact: true }).click();
  await timeline.getByLabel("Team member", { exact: true }).click();
  await page.getByRole("option", { name: "Sign-in analyst", exact: true }).click();
  await expect(page).toHaveURL(/member=worker/);
  await expect(entries.first()).toHaveText("A message was sent to Sign-in analyst");
  expect(await kinds()).toEqual(["message"]);
  await timeline.getByLabel("Kind", { exact: true }).click();
  await page.getByRole("option", { name: "Decision", exact: true }).click();
  await expect(timeline.getByText("Nothing matches these filters", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(entries).toHaveCount(total);

  // An entry links to its source: the decision opens the Brief on that decision.
  await timeline.locator('[data-timeline-entry][data-kind="decision"]').locator("xpath=ancestor::li[1]").getByRole("link", { name: /Open the decision/ }).click();
  await expect(page).toHaveURL(/\/brief\?.*decision=/);
  await expect(page.locator("[data-decision][aria-current='true']")).toContainText("Check the session cookie before anything else");

  // The run entry opens the run, and its Tool calls tab lists the calls without leaving the mission.
  await page.goBack();
  const runRow = timeline.locator('[data-timeline-entry][data-kind="run"]').locator("xpath=ancestor::li[1]");
  await expect(runRow.getByRole("link", { name: /Tool calls \(2\)/ })).toBeVisible();
  await runRow.getByRole("link", { name: /Tool calls \(2\)/ }).click();
  await expect(page).toHaveURL(/\/runs\/[^?]+\?tab=tool-calls/);
  const calls = page.getByTestId("run-tool-calls");
  await expect(calls.locator('[data-tool-call="documents.read"]')).toHaveAttribute("data-outcome", "succeeded");
  await expect(calls.locator('[data-tool-call="web.fetch"]')).toHaveAttribute("data-outcome", "failed");
  await expect(calls.getByText("allowlist", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "Back to the mission timeline", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/timeline/);
  await expect(page.getByTestId("mission-timeline")).toBeVisible();

  // On a phone the same timeline reads without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("mission-timeline")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});
