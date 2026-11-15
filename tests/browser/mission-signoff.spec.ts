import { test, expect } from "./fixtures";
import type { ActorContext } from "@brain/contracts";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * Mission sign-off (#92) as a first-time user meets it, on real runners and the fixture engine: the finished mission raises a
 * "ready for sign-off" item in Needs you, the Outputs tab takes the verdict, a rejection needs findings and returns the mission to work,
 * and a verified mission closes as achieved. The planner's proposal row is the only direct write ("ask Brain" is covered elsewhere).
 */
test("a finished mission waits for sign-off: reject with findings, finish again, verify and close as achieved", async ({ page, governor }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "signoff");
  brain.createWorkspace(actor, { workspaceId: "ws-sign", slug: "sign" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const scoped: ActorContext = (await brain.resolveActor(new Headers({ cookie }), "ws-sign")).actor;
  expect(scopesForPrincipal(brain.store, scoped.actorId, scoped.organizationId, "ws-sign")).toContain("mission:write");
  const sessions = await enrollRunners(governor, actor, "sign");
  const ws = brain.store.workspaceDb("ws-sign", actor.organizationId);
  const row = <T,>(sql: string, ...args: unknown[]) => ws.prepare(sql).get(...args) as T;
  const verdictOf = (missionId: string) => row<{ state: string; independence: string | null }>("SELECT state, verdict_independence AS independence FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1", missionId);
  const stateOf = (missionId: string) => row<{ state: string; outcome: string | null }>("SELECT state, outcome FROM missions WHERE id=?", missionId);
  const shot = async (name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

  // A mission in plain words, tasks started by the person; one task so the mission finishes with a single accept.
  await page.goto(`${governor.url}/w/ws-sign/missions/new`);
  const form = page.getByRole("dialog");
  await form.getByLabel(/^What do you want done/).fill("Summarize the quarterly incident log");
  await form.getByText("More options", { exact: true }).click();
  await form.getByLabel("Starting tasks", { exact: true }).click();
  await page.getByRole("option", { name: "Ask me before each task", exact: true }).click();
  await form.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = row<{ id: string }>("SELECT id FROM missions WHERE title LIKE 'Summarize the quarterly%'").id;
  const key = `plan-${missionId}`;
  const { receipt } = await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-sign", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary: "Read the log, then summarize it", tasks: [{ id: "inspect", title: "Summarize the incident log", criteria: ["structure", "safety"], dependsOn: [], workflowId: "operations-triage", criterionIds: ["c1"] }] },
  } as never, key);
  expect(receipt.accepted).toBe(true);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await page.getByRole("button", { name: "Start Summarize the incident log", exact: true }).first().click();
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.waitForURL(/\/runs\//);
  const taskState = () => row<{ state: string }>("SELECT state FROM work_items WHERE mission_id=? AND state!='abandoned'", missionId).state;
  await driveRuns(sessions, () => taskState() === "review");

  // The person accepts the finished task on the Outputs tab, then finishes the mission.
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs`);
  await expect(page.getByTestId("mission-signoff")).toHaveCount(0);
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toBeEnabled({ timeout: 30_000 });
  await accept.click();
  await expect.poll(taskState, { timeout: 30_000 }).toBe("done");
  await page.getByRole("button", { name: "Finish mission", exact: true }).click();
  await expect.poll(() => stateOf(missionId).state, { timeout: 30_000 }).toBe("verifying");
  expect(verdictOf(missionId).state).toBe("submitted");

  // Needs you says the mission is ready for sign-off and opens the sign-off view.
  await page.goto(`${governor.url}/w/ws-sign/today`);
  const queue = page.getByTestId("needs-you");
  const item = queue.getByTestId("needs-you-item").filter({ hasText: "ready for sign-off" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toHaveAttribute("data-kind", "sign-off");
  await expect(page.getByRole("button", { name: /^Needs you: 1/ })).toBeVisible();
  await item.getByRole("button", { name: "Review and sign off", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/outputs/);
  const signOff = page.getByTestId("mission-signoff");
  await expect(signOff).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  await expect(signOff.getByTestId("signoff-facts")).toContainText("1 task done");
  // Every success criterion is listed with the work serving it. The workflow's own checks passed, but none names the criterion, so the
  // owner is told it is not linked to a check before the verdict buttons (ADR 0034).
  const criterion = signOff.getByTestId("signoff-criterion");
  await expect(criterion).toHaveCount(1);
  await expect(criterion).toHaveAttribute("data-linked", "false");
  await expect(criterion).toContainText("Not linked to a check");
  await expect(criterion.getByTestId("signoff-criterion-work")).toContainText("Work: Summarize the incident log");
  await expect(signOff.getByTestId("signoff-criterion-check")).toHaveCount(0);
  await expect(signOff.getByTestId("signoff-criteria-summary")).toHaveText("0 of 1 success criterion is linked to a check");
  const warning = signOff.getByTestId("signoff-unlinked-warning");
  await expect(warning).toContainText("1 success criterion is not linked to a check");
  const verifyButton = signOff.getByRole("button", { name: "Verify the mission", exact: true });
  expect((await warning.boundingBox())!.y).toBeLessThan((await verifyButton.boundingBox())!.y);
  await shot("signoff-waiting");

  // A rejection needs findings: the button stays off until one is written, then the mission returns to work.
  await signOff.getByRole("button", { name: "Reject with findings", exact: true }).click();
  const sendBack = signOff.getByRole("button", { name: "Send back to work", exact: true });
  await expect(sendBack).toBeDisabled();
  await signOff.getByLabel(/^What needs fixing/).fill("  \n ");
  await expect(sendBack).toBeDisabled();
  await signOff.getByLabel(/^What needs fixing/).fill("The summary skips the two outages in March\nName the owner of each follow-up");
  await shot("signoff-rejecting");
  await sendBack.click();
  await expect(signOff).toHaveCount(0, { timeout: 30_000 });
  expect(stateOf(missionId)).toEqual({ state: "active", outcome: null });
  expect(verdictOf(missionId)).toEqual({ state: "rejected", independence: "L3" });
  const routed = row<{ body: string }>("SELECT body FROM mission_messages WHERE mission_id=? AND sender_id='governor' ORDER BY created_at_ms DESC LIMIT 1", missionId).body;
  expect(routed).toContain("The summary skips the two outages in March");
  expect(routed).toContain("Name the owner of each follow-up");

  // The work is still done: finishing again submits a new bundle and a new sign-off item; verifying lets the person close it.
  await page.getByRole("button", { name: "Finish mission", exact: true }).click();
  await expect(signOff).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  await signOff.getByRole("button", { name: "Verify the mission", exact: true }).click();
  await expect(signOff).toHaveAttribute("data-state", "verified");
  expect(verdictOf(missionId)).toEqual({ state: "verified", independence: "L3" });
  await shot("signoff-verified");
  await signOff.getByRole("button", { name: "Close as achieved", exact: true }).click();
  await signOff.getByRole("button", { name: "Yes, the goal is achieved", exact: true }).click();
  await expect(signOff).toHaveAttribute("data-state", "signed-off", { timeout: 30_000 });
  await expect(signOff.getByTestId("signoff-done")).toContainText("Signed off by a person");
  expect(stateOf(missionId)).toEqual({ state: "closed", outcome: "achieved" });
  await shot("signoff-closed");

  // Nothing waits for a decision any more.
  await page.goto(`${governor.url}/w/ws-sign/today`);
  await expect(page.getByRole("button", { name: "Needs you: nothing waiting" })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

/** A person who cannot dispatch sees the sign-off and is told who can record it. */
test("a viewer sees the sign-off view but cannot record a verdict", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "signview");
  brain.createWorkspace(actor, { workspaceId: "ws-view", slug: "view" });
  const scoped: ActorContext = (await brain.resolveActor(new Headers({ cookie }), "ws-view")).actor;
  const ws = brain.store.workspaceDb("ws-view", actor.organizationId);
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-view", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const version = () => (ws.prepare("SELECT version FROM missions WHERE id=?").get(missionId) as { version: number }).version;
  const missionId = (await cmd("mission.create", "view-create", { title: "Read-only review", intent: "Review the notes", successCriteria: ["done"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "view-plan", { missionId, origin: "manual", summary: "Plan", tasks: [{ id: "t", title: "Review the notes", criteria: ["Notes reviewed"], dependsOn: [] }] })).resourceId ?? "";
  await cmd("plan.confirm", "view-confirm", { planVersionId: planId }, version());
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(`sha256:${"9".repeat(64)}`, missionId);
  await cmd("mission.proposeCompletion", "view-propose", { missionId }, version());
  brain.store.control.prepare("UPDATE workspace_memberships SET role='viewer' WHERE workspace_id='ws-view' AND principal_id=? AND revoked_at_ms IS NULL").run(actor.actorId);
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs?w=ws-view`);
  const signOff = page.getByTestId("mission-signoff");
  await expect(signOff).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  await expect(signOff.getByTestId("signoff-criterion")).toContainText("No task serves this criterion");
  await expect(signOff.getByTestId("signoff-criterion")).toContainText("Not linked to a check");
  await expect(signOff.getByTestId("signoff-no-scope")).toContainText("only an operator can record the verdict");
  await expect(signOff.getByRole("button", { name: "Verify the mission", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
