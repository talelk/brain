import { test, expect } from "./fixtures";
import { fixtureGate } from "../../apps/runner/src/engines/fixture";
import { runOnce } from "../../apps/runner/src/supervisor";
import { fixtureStarter } from "../support/starter";
import { enrollRunners, signUpOwner } from "../support/flow";

/**
 * Stories 112 and 113 (ADR 0045), walked as a first-time administrator under Administration, "How work runs": the autonomy ceiling is chosen
 * in words, confirmed with a fresh step-up and read back; "Stop all sessions" names what will stop, needs a reason, ends a really running
 * session, pauses the mission with the reason, shows it in Needs you, and the mission resumes when the person says so.
 */
test("an administrator sets the autonomy ceiling and stops all sessions, and the stopped mission says why until it is resumed", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "stopall");
  brain.createWorkspace(actor, { workspaceId: "ws-stop", slug: "stop" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  const sessions = await enrollRunners(governor, actor, "stop", ["agents", "evaluators"]);
  const member = (await brain.resolveActor(new Headers({ cookie }), "ws-stop")).actor;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(member, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-stop", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const mission = async (id: string) => ((await brain.executeQuery(member, { queryType: "missions.get", workspaceId: "ws-stop", resourceId: id })) as unknown as { snapshot: { version: number; state: string; pauseReason?: string } }).snapshot;

  // The ceiling: found in Administration, "How work runs"; the three levels are explained before anything is chosen.
  await page.goto(`${governor.url}/w/ws-stop/today`);
  await expect(page.getByLabel(/^What do you want done/)).toBeEnabled({ timeout: 30_000 });
  await page.goto(`${governor.url}/settings?tab=work`);
  const ceiling = page.locator("[data-work-ceiling]");
  await expect(ceiling).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Autonomy ceiling", exact: true })).toBeVisible();
  await expect(page.locator("[data-work-ceiling-current]")).toHaveText("No ceiling has been set, so every level of autonomy is allowed.");
  await expect(ceiling.getByText("Every other change to the plan (adding, changing, removing or reassigning tasks) waits for a person to confirm.")).toBeVisible();
  const change = ceiling.getByRole("button", { name: "Change the ceiling…", exact: true });
  await expect(change).toBeDisabled();
  await ceiling.getByText("Supervised", { exact: true }).click();
  await expect(change).toBeEnabled();
  await change.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Change the autonomy ceiling" })).toBeVisible();
  await expect(dialog).toContainText("no mission in this workspace can be given more autonomy than Supervised");
  await expect(dialog.getByText("Brain checks your signed-in session again for this one change.")).toBeVisible();
  await dialog.getByRole("button", { name: "Change the ceiling", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(ceiling.getByRole("status")).toHaveText("The autonomy ceiling is now Supervised.");
  await expect(page.locator("[data-work-ceiling-current]")).toHaveText("Current ceiling: Supervised.", { timeout: 30_000 });
  await expect(ceiling).toHaveAttribute("data-work-ceiling", "supervised");
  // A mission asked to be autonomous is held to the ceiling.
  const clipped = (await cmd("mission.create", "stop-ceiling", { title: "Held to the ceiling", intent: "Check the ceiling", successCriteria: ["done"], autonomy: "autonomous" })).resourceId ?? "";
  expect(((await brain.executeQuery(member, { queryType: "missions.get", workspaceId: "ws-stop", resourceId: clipped })) as unknown as { snapshot: { autonomyPolicy: { operations: string[] } } }).snapshot.autonomyPolicy.operations).toEqual(["conflictTask.create"]);

  // A mission with one task that a real runner is running (the fixture engine waits at the gate, as a long session would).
  let entered!: (attemptId: string) => void;
  const enteredAttempt = new Promise<string>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixtureGate.hold = async (attemptId) => { entered(attemptId); await gate; };
  try {
    const missionId = (await cmd("mission.create", "stop-mission", { title: "Compare two venues", intent: "Compare two venues", successCriteria: ["Both venues are compared"] })).resourceId ?? "";
    const planId = (await cmd("plan.propose", "stop-plan", { missionId, origin: "manual", tasks: [{ id: "compare", title: "Compare the venues", criteria: ["Both venues are compared"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId ?? "";
    await cmd("plan.confirm", "stop-confirm", { planVersionId: planId }, (await mission(missionId)).version);
    // The production loop logs a protocol error and goes on; so does this one (a fenced attempt's upload is refused as LEASE_LOST).
    const working = (async () => { for (let round = 0; round < 3; round++) for (const session of sessions) await runOnce(session.cfg, session.sessionToken, session.epoch).catch((error: unknown) => { if (!/LEASE_LOST|fenced/u.test(String(error))) throw error; return false; }); })();
    const attemptId = await enteredAttempt;
    expect((brain.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(attemptId) as { state: string }).state).toBe("running");

    // The emergency stop: the confirmation names what will stop, and nothing happens without a reason.
    await page.goto(`${governor.url}/settings?tab=work`);
    const stop = page.locator("[data-work-stop]");
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Stop all sessions", exact: true })).toBeVisible();
    await expect(page.locator("[data-work-stop-live]")).toHaveText("Running sessions right now: 1.", { timeout: 30_000 });
    await stop.getByRole("button", { name: "Stop all sessions…", exact: true }).click();
    const sure = page.getByRole("dialog");
    await expect(sure.getByRole("heading", { name: "Stop all sessions?" })).toBeVisible();
    await expect(sure.locator("[data-work-stop-names]")).toContainText("Running sessions that will be stopped: 1");
    await expect(sure.locator("[data-stop-mission]").filter({ hasText: "Compare two venues" })).toContainText("1 running");
    await expect(sure.locator("[data-work-stop-names]")).toContainText("Missions that will be paused:");
    const confirm = sure.getByRole("button", { name: "Stop all sessions", exact: true });
    await expect(confirm).toBeDisabled();
    await sure.getByLabel("Why are you stopping everything?").fill("The agent is touching the wrong repository");
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("stop-all-confirm.png") });
    await confirm.click();
    await expect(sure).toBeHidden({ timeout: 30_000 });
    await expect(stop.getByRole("status")).toContainText("All sessions stopped (1 ended).");
    await expect(page.locator("[data-work-stop-live]")).toHaveText("No session is running right now.", { timeout: 30_000 });

    // The session really ended: a fenced attempt, and when the engine finally reports, Brain ignores it.
    expect((brain.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(attemptId) as { state: string }).state).toBe("cancelled");
    release();
    await working;
    expect((brain.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(attemptId) as { state: string }).state).toBe("cancelled");
    expect(await mission(missionId)).toMatchObject({ state: "paused", pauseReason: "stopped" });

    // The mission page says why it stopped and what to do; Needs you carries it too.
    await page.goto(`${governor.url}/missions/${missionId}/plan`);
    await expect(page.getByText("an administrator stopped all sessions. Reason: The agent is touching the wrong repository").first()).toBeVisible({ timeout: 30_000 });
    await page.goto(`${governor.url}/w/ws-stop/today`);
    const needsYou = page.getByText("Compare two venues was paused: all sessions were stopped");
    await expect(needsYou).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Why: The agent is touching the wrong repository").first()).toBeVisible();

    // The administrator resumes the mission when it is safe: the stopped task runs again as a new attempt.
    await page.goto(`${governor.url}/missions/${missionId}/plan`);
    await page.getByRole("button", { name: /^Resume/ }).first().click();
    await expect.poll(async () => (await mission(missionId)).state, { timeout: 30_000 }).toBe("active");
    fixtureGate.hold = async () => undefined;
    await expect.poll(async () => { for (const session of sessions) await runOnce(session.cfg, session.sessionToken, session.epoch); return (brain.store.control.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('verifying','succeeded')").get() as { n: number }).n; }, { timeout: 60_000 }).toBeGreaterThan(0);
  } finally { delete fixtureGate.hold; release(); }
  expect(errors).toEqual([]);
});
