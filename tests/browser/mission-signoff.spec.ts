import { test, expect } from "./fixtures";
import type { ActorContext } from "@brain/contracts";
import { driveRuns, enrollRunners, signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import type { Brain } from "../../apps/governor/src/application/brain";

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
  // No hosted model is on in this workspace: the view says plainly that no judge ran, and nothing stands in for an opinion (never read as a pass).
  const noJudge = signOff.getByTestId("signoff-judge");
  await expect(noJudge).toHaveAttribute("data-judge", "not-run");
  await expect(noJudge).toContainText("No judge ran: no hosted model is switched on for this workspace");
  await expect(noJudge).toContainText("That is not a pass");
  await expect(signOff.getByTestId("signoff-criterion-advisory")).toHaveCount(0);
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

/**
 * The advisory judge (#95) as a person meets it. An administrator turns the workspace's hosted model on in the settings form; when a
 * mission is finished the judge's opinion appears beside each criterion it could read about, marked advisory, and never stands in for the
 * check that links a criterion or for the person's verdict. A model that does not answer leaves the view saying so, and sign-off still works.
 * The finished work is seeded through commands (its evidence needs a real runner; the first test above walks that); the model is a fake
 * behind the Governor's own network port.
 */
async function seedFinishedMission(brain: Brain, actor: ActorContext, cookie: string, workspaceId: string, label: string): Promise<string> {
  const scoped: ActorContext = (await brain.resolveActor(new Headers({ cookie }), workspaceId)).actor;
  const ws = brain.store.workspaceDb(workspaceId, actor.organizationId);
  const cmd = async (actorOf: ActorContext, type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(actorOf, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const version = () => (ws.prepare("SELECT version FROM missions WHERE id=?").get(missionId) as { version: number }).version;
  const missionId = (await cmd(scoped, "mission.create", `${label}-create`, { title: "Summarize the quarterly incident log", intent: "Summarize the incident log", successCriteria: ["Every incident is listed", "A recommendation is made", "Risks are named"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd(scoped, "plan.propose", `${label}-plan`, { missionId, origin: "manual", summary: "Plan", tasks: [
    { id: "list", title: "List the incidents", criteria: ["Incidents listed"], dependsOn: [], criterionIds: ["c1"] },
    { id: "advise", title: "Write the recommendation", criteria: ["Recommendation written"], dependsOn: [], criterionIds: ["c2"] },
  ] })).resourceId ?? "";
  await cmd(scoped, "plan.confirm", `${label}-confirm`, { planVersionId: planId }, version());
  const items = ws.prepare("SELECT id, plan_task_id FROM work_items WHERE mission_id=?").all(missionId) as Array<{ id: string; plan_task_id: string }>;
  const agent: ActorContext = { ...scoped, kind: "agent" };
  for (const item of items) await cmd(agent, "handoff.submit", `${label}-handoff-${item.plan_task_id}`, { workItemId: item.id, notes: { summary: item.plan_task_id === "list" ? "Listed all 14 incidents of the quarter with their owners." : "Recommended a staffed on-call rota for March." } });
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(`sha256:${"7".repeat(64)}`, missionId);
  return missionId;
}

test("with a hosted model the judge's opinions appear beside the evidence, marked advisory, and never replace a check or the verdict", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "judged");
  brain.createWorkspace(actor, { workspaceId: "ws-judge", slug: "judge" });
  // The fake hosted model answers behind the Governor's own network port: pass for the incident list, fail for the recommendation.
  const asked: string[] = [];
  brain.modelFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    const prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0]!.content;
    asked.push(prompt);
    const verdict = prompt.includes("recommendation") ? { verdict: "fail", rationale: "no rota is costed" } : { verdict: "pass", rationale: "all 14 incidents are listed" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), { status: 200 });
  }) as typeof fetch;

  // The administrator turns the hosted model on through the settings form.
  await page.goto(`${governor.url}/settings?tab=work&w=ws-judge`);
  const hosted = page.locator("[data-work-hosted]");
  await expect(hosted.locator("[data-work-routes-empty]")).toBeVisible({ timeout: 30_000 });
  await expect(hosted).toContainText("advisory model judge");
  await hosted.getByRole("button", { name: "Add a route", exact: true }).click();
  const route = hosted.locator("[data-work-route='1']");
  await route.getByRole("checkbox", { name: "Use this route (route 1)" }).check();
  await route.getByLabel("Route name (route 1)").fill("judge");
  await route.getByLabel("API key reference (route 1)").fill("acme-judge");
  await route.getByLabel("Vendor (route 1)").fill("Acme");
  await route.getByLabel("Model (route 1)").fill("acme-judge");
  await route.getByLabel("Address (route 1)").fill("https://judge.acme.example/v1");
  await route.getByLabel("Input price (USD per million tokens) (route 1)").fill("0.15");
  await route.getByLabel("Output price (USD per million tokens) (route 1)").fill("0.6");
  await hosted.getByRole("button", { name: "Save", exact: true }).click();
  await expect(hosted.getByRole("status")).toHaveText("The model routes were saved.");

  // The person finishes the mission; the sign-off view appears and the judge reads the evidence.
  const missionId = await seedFinishedMission(brain, actor, cookie, "ws-judge", "judged");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs?w=ws-judge`);
  await page.getByRole("button", { name: "Finish mission", exact: true }).click();
  const signOff = page.getByTestId("mission-signoff");
  await expect(signOff).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  const judge = signOff.getByTestId("signoff-judge");
  await expect(judge).toHaveAttribute("data-judge", "done", { timeout: 30_000 });
  await expect(judge).toContainText("Model judge acme-judge gave its opinion");
  await expect(judge).toContainText("advisory only");
  const criteria = signOff.getByTestId("signoff-criterion");
  await expect(criteria).toHaveCount(3);
  // Opinions sit beside the criteria they are about, marked as a model's opinion; the criterion nobody wrote anything about says so.
  await expect(criteria.nth(0).getByTestId("signoff-criterion-advisory")).toHaveText("Model opinion, advisory only: judge:acme-judge says passed");
  await expect(criteria.nth(1).getByTestId("signoff-criterion-advisory")).toHaveText("Model opinion, advisory only: judge:acme-judge says failed");
  await expect(criteria.nth(2).getByTestId("signoff-criterion-no-opinion")).toBeVisible();
  // A model's pass links nothing: every criterion is still "not linked to a check", and the warning stands above the verdict buttons.
  await expect(criteria.nth(0)).toHaveAttribute("data-linked", "false");
  await expect(criteria.nth(0)).toContainText("Not linked to a check");
  await expect(signOff.getByTestId("signoff-unlinked-warning")).toContainText("3 success criteria are not linked to a check");
  expect(asked).toHaveLength(2);
  expect(asked[0]).toContain("Listed all 14 incidents of the quarter with their owners.");
  if (process.env["TODAY_SHOTS"]) await signOff.screenshot({ path: `${process.env["TODAY_SHOTS"]}/signoff-judged-element.png` });
  // The mission is still waiting for the person: the judge decided nothing, and its two calls are the mission's priced spend.
  const db = brain.store.workspaceDb("ws-judge", actor.organizationId);
  expect(db.prepare("SELECT state, verdict_by FROM mission_evidence_bundles WHERE mission_id=?").get(missionId)).toEqual({ state: "submitted", verdict_by: null });
  expect((db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS micro FROM mission_spend WHERE mission_id=?").get(missionId) as { micro: number }).micro).toBe(2 * Math.ceil((900 * 150_000 + 60 * 600_000) / 1_000_000));

  // The person verifies; the opinions stay beside the evidence afterwards.
  await signOff.getByRole("button", { name: "Verify the mission", exact: true }).click();
  await expect(signOff).toHaveAttribute("data-state", "verified");
  await expect(signOff.getByTestId("signoff-criterion-advisory")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("a hosted model that does not answer leaves no opinion and does not stop the person signing off", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "outage");
  brain.createWorkspace(actor, { workspaceId: "ws-outage", slug: "outage" });
  let asked = 0;
  brain.modelFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    asked += 1;
    return new Response("overloaded", { status: 503 });
  }) as typeof fetch;
  const scoped: ActorContext = (await brain.resolveActor(new Headers({ cookie }), "ws-outage")).actor;
  const set = await brain.executeCommand(scoped, {
    contractVersion: "brain.command/v1", commandId: "cmd-hosted", commandType: "workspace.modelRoutes.set", workspaceId: "ws-outage", idempotencyKey: "hosted",
    payload: { routes: [{ routeId: "judge", enabled: true, vendor: "Acme", keyRef: "acme-judge", costTier: "standard", model: "acme-judge", baseUrl: "https://judge.acme.example/v1", inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000 }] },
  } as never, "hosted");
  expect(set.receipt.accepted).toBe(true);
  const missionId = await seedFinishedMission(brain, actor, cookie, "ws-outage", "outage");
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/outputs?w=ws-outage`);
  await page.getByRole("button", { name: "Finish mission", exact: true }).click();
  const signOff = page.getByTestId("mission-signoff");
  await expect(signOff).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  const judge = signOff.getByTestId("signoff-judge");
  await expect(judge).toHaveAttribute("data-judge", "unavailable", { timeout: 30_000 });
  await expect(judge).toContainText("The model judge could not be reached");
  await expect(judge).toContainText("You can sign off without it");
  await expect(signOff.getByTestId("signoff-criterion-advisory")).toHaveCount(0);
  await expect(signOff.getByTestId("signoff-criterion-no-opinion")).toHaveCount(0);
  expect(asked).toBe(1);
  if (process.env["TODAY_SHOTS"]) await signOff.screenshot({ path: `${process.env["TODAY_SHOTS"]}/signoff-judge-unavailable-element.png` });
  // Nothing was written in the model's place, and the person can still verify.
  expect(brain.store.workspaceDb("ws-outage", actor.organizationId).prepare("SELECT COUNT(*) AS n FROM mission_bundle_checks").get()).toEqual({ n: 0 });
  await signOff.getByRole("button", { name: "Verify the mission", exact: true }).click();
  await expect(signOff).toHaveAttribute("data-state", "verified");
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
  await expect(signOff.getByTestId("signoff-judge")).toContainText("No judge ran");
  await expect(signOff.getByTestId("signoff-no-scope")).toContainText("only an operator can record the verdict");
  await expect(signOff.getByRole("button", { name: "Verify the mission", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
