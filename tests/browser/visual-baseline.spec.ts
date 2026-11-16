/**
 * Visual baselines for the key screens at 1440-light, 768-light and 390-dark.
 *
 * UPDATING THESE SNAPSHOTS IS A DELIBERATE ACT. A diff here means the UI changed: look at the actual
 * and diff images in test-results/, decide the change is intended, then regenerate with
 *   TMPDIR=$HOME/.cache/bt npx playwright test tests/browser/visual-baseline.spec.ts \
 *     --project=1440-light --project=768-light --project=390-dark --update-snapshots
 * and commit the new PNGs in tests/browser/visual-baseline.spec.ts-snapshots/ in the same change as
 * the UI work. Never refresh them just to make a red run green. Comparisons allow 2% of pixels to
 * differ (anti-aliasing only: no screen widens that); they run on the seeded workspace from
 * tests/support/browserDemo.ts.
 *
 * Determinism (ticket #160): the Governor clock runs from a fixed day (pinClock) and the page clock is fixed to it before every
 * navigation, in UTC; background auto-start is swept to rest before each screen; the page is shot only after the network is idle and
 * the layout has stopped moving, scrolled with place() to a rounded pixel position; generated ids (trace id, webhook addresses, digests) and
 * times of things made during the run are masked. The screens run in one test, in order, because later screens count what earlier ones made;
 * a mismatch on one screen is recorded and the next screens still run.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedBrowserDemo } from "../support/browserDemo";
import { seedHuman } from "../helpers";
import { sendTaskBack } from "../support/evalCases";
import { command, interruptedSession } from "../support/interrupted-session";
import { PAUSABLE_FEATURES, runnerReports, runningSession } from "../support/running-session";
import { seedStaleKnowledge } from "../support/stale-knowledge";
import { seedPullRequest } from "../support/pullRequestDemo";
import { seedChangeApproval } from "../support/changeApprovalDemo";
import { seedQuestion } from "../support/question-demo";
import { finishCandidates, seedCandidateMission, stageSingleStepWorkflows, steadyDurations } from "../support/candidates-world";
import { seedAgentActivity } from "../support/agent-activity";
import { autonomyContext, cleanMission, cleanPlayMissions } from "../support/autonomy-world";
import { delegationsOf, driveChildren, enrollChildRunners } from "../support/delegation-world";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { seedWhyRun } from "../support/why-demo";

test.use({ timezoneId: "UTC" });

type Brain = Parameters<typeof seedBrowserDemo>[1]["app"]["brain"];

/**
 * The clock of this run: the Governor lives in this process, so its Date (and every timestamp the test helpers make) starts at a fixed midday (in the future, so session cookies the browser holds are never already expired)
 * UTC date and runs on at the real rate, so dates, spend days and ages are the same on every run while leases and offers still expire.
 */
const CLOCK_START_MS = Date.parse("2035-06-13T12:00:00Z");
const RealDate = Date;
function pinClock(): () => number {
  const realStart = RealDate.now();
  const nowMs = () => CLOCK_START_MS + (RealDate.now() - realStart);
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) { if (args.length === 0) super(nowMs()); else super(...(args as [number])); }
    static override now(): number { return nowMs(); }
  }
  globalThis.Date = PinnedDate as unknown as DateConstructor;
  return nowMs;
}

/**
 * Scrolls `element` to `block` of whatever scrolls it (like scrollIntoView, instantly), then rounds every scroll offset on the way to a whole
 * pixel. The request is kept so settle() can place it again once the layout has stopped moving: a late-arriving section above it would
 * otherwise leave the shot a few pixels off.
 */
function place(element: Element, block: string): void {
  const state = window as unknown as { __vbPlace?: () => void };
  const apply = () => {
    if (!element.isConnected) return;
    // From the top every time: "nearest" (and an element taller than the window) otherwise lands differently depending on where the page already was.
    for (let node: Element | null = element.parentElement; node; node = node.parentElement) if (node.scrollTop !== 0) node.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "instant" });
    if (block === "ifneeded") {
      const box = element.getBoundingClientRect();
      if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    }
    element.scrollIntoView({ block: block === "ifneeded" ? "nearest" : (block as ScrollLogicalPosition), behavior: "instant" });
    for (let node: Element | null = element.parentElement; node; node = node.parentElement) if (node.scrollTop !== Math.round(node.scrollTop)) node.scrollTop = Math.round(node.scrollTop);
    if (window.scrollY !== Math.round(window.scrollY)) window.scrollTo({ top: Math.round(window.scrollY), behavior: "instant" });
  };
  state.__vbPlace = apply;
  apply();
}

/** Waits for the network to go idle and the page height to stay put for several frames, then places the last requested scroll again. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    let last = "", same = 0;
    for (let frames = 0; same < 6 && frames < 200; frames++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
      const height = `${document.documentElement.scrollHeight}:${document.body.scrollHeight}`;
      same = height === last ? same + 1 : 0;
      last = height;
    }
    (window as unknown as { __vbPlace?: () => void }).__vbPlace?.();
  });
}

/** Background work (the auto-start timer) can move a count while a screen loads: it is run to rest before the page opens. */
async function quiesce(brain: Brain): Promise<void> {
  const jobs = () => JSON.stringify(brain.store.control.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all());
  for (let round = 0; round < 10; round++) {
    const before = jobs();
    await brain.autoStart.sweepAll();
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (jobs() === before) return;
  }
}

type Demo = Awaited<ReturnType<typeof seedBrowserDemo>>;
type Fixture = Parameters<typeof seedBrowserDemo>[1];

/** A finished one-task mission with a submitted bundle, made when its screen is reached so no earlier screen changes. */
async function signOffRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const version = async (id: string) => ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
  const missionId = (await cmd("mission.create", "baseline-signoff-create", { title: "Compile the quarterly report", intent: "Compile the quarterly report", successCriteria: ["The report is complete", "Every figure cites its source"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "baseline-signoff-plan", { missionId, origin: "manual", tasks: [{ id: "compile", title: "Compile the figures", criteria: ["Figures compiled"], dependsOn: [], criterionIds: ["c1"] }] })).resourceId ?? "";
  await cmd("plan.confirm", "baseline-signoff-confirm", { planVersionId: planId }, await version(missionId));
  // The finished task's verified evidence has one check that names the first criterion; the second criterion is served by no task, so it shows as not linked.
  const ws = brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const evidence = `sha256:${"9".repeat(64)}`;
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run(evidence, "bundle-baseline", "job-baseline", "att-baseline", JSON.stringify({ checks: [{ criterionId: "c1", checkId: "figures-reconcile", status: "passed" }] }), brain.store.now());
  ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(evidence, missionId);
  await cmd("mission.proposeCompletion", "baseline-signoff-finish", { missionId }, await version(missionId));
  return `/missions/${missionId}/outputs`;
}

/** A team member's question to a person (ticket #109), made when its screen is reached; both question screens show this one mission. */
let questionMission: string | undefined;
async function questionRoute(demo: Demo, governor: Fixture): Promise<string> {
  questionMission ??= (await seedQuestion(governor.app.brain, demo.actor, demo.workspaceId, { key: "vb-question", title: "Compile the quarterly report figures", question: "Which quarter should the report cover?" })).missionId;
  return `/missions/${questionMission}/live`;
}

/** A browser that can receive notifications (headless Chromium has permission denied and no push service): asked never, or turned on for this device. */
async function pushDevice(page: Page, on: boolean): Promise<void> {
  await page.addInitScript((subscribed) => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => (subscribed ? "granted" : "default") });
    const device = { endpoint: "http://127.0.0.1:9/push/baseline", toJSON: () => ({}), unsubscribe: async () => true };
    PushManager.prototype.getSubscription = async () => (subscribed ? (device as unknown as PushSubscription) : null);
  }, on);
}

/** A run with a team member, a way of working and model routes behind it (ticket #144), made when its screen is reached: the run page open on its Why tab. */
async function whyRoute(demo: Demo, governor: Fixture): Promise<string> {
  // Its own workspace, so the runner below is offered this run's job and not one of the demo's queued jobs.
  const brain = governor.app.brain;
  brain.createWorkspace(demo.actor, { workspaceId: "why-baseline", slug: "why-baseline" });
  const scoped = { ...demo.actor, workspaceId: "why-baseline", scopes: scopesForPrincipal(brain.store, demo.actor.actorId, demo.actor.organizationId, "why-baseline") };
  const { jobId } = await seedWhyRun(governor as never, scoped, "why-baseline", "baseline-why");
  return `/runs/${jobId}?tab=placement&w=why-baseline`;
}

/** A task run as three candidates (#127), made when its screen is reached: two finished (one verified), one failed; the task is open in its mission. */
async function candidatesRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  stageSingleStepWorkflows(brain, demo.actor);
  const { missionId, workItemId } = await seedCandidateMission(brain, demo.actor, demo.workspaceId, { key: "vb-candidates", title: "Compare three briefs", autoStart: true });
  await finishCandidates(brain, demo.actor, demo.workspaceId, workItemId);
  steadyDurations(brain, demo.actor, demo.workspaceId, workItemId);
  return `/missions/${missionId}/plan?item=${workItemId}`;
}

/** The same task before any candidate has started: its plan editor open on the step's candidates. */
async function candidatePlanRoute(demo: Demo, governor: Fixture): Promise<string> {
  stageSingleStepWorkflows(governor.app.brain, demo.actor);
  const { missionId } = await seedCandidateMission(governor.app.brain, demo.actor, demo.workspaceId, { key: "vb-candidate-plan", title: "Compare three briefs, planned", autoStart: false });
  return `/missions/${missionId}/plan`;
}

/** A mission with a confirmed two-member team, made when its screen is reached; the screen is its plan editor open on the team and the first step. */
async function planEditorRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await cmd("mission.create", "baseline-team-create", { title: "Prepare the vendor review", intent: "Prepare the vendor review", successCriteria: ["The review is ready"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd("plan.propose", "baseline-team-plan", { missionId, origin: "manual", team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }, { memberId: "reviewer", role: "Reviewer", agentId: "support-analyst", engine: "fixture" }],
    tasks: [{ id: "read", title: "Read the vendor sheet", criteria: ["Every vendor row is read"], dependsOn: [], requiredTools: ["csv.query"], assignment: { kind: "agent", id: "writer", role: "specialist" } }, { id: "review", title: "Review the summary", criteria: ["The summary is checked"], dependsOn: ["read"], assignment: { kind: "agent", id: "reviewer", role: "specialist" } }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await cmd("plan.confirm", "baseline-team-confirm", { planVersionId: planId }, version);
  return `/missions/${missionId}/plan`;
}

/** A mission from the coordinator Play with its starting plan confirmed, made when its screen is reached; the screen is its Team tab with the coordinator marked. */
async function coordinatedTeamRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await cmd("mission.create", "baseline-coordinator-create", { title: "Research the offsite venues", playId: "research-with-coordinator", autoStart: false })).resourceId ?? "";
  const planId = (brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId).prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(missionId) as { id: string }).id;
  const version = ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await cmd("plan.confirm", "baseline-coordinator-confirm", { planVersionId: planId }, version);
  return `/missions/${missionId}/team`;
}

/**
 * Delegated work (ticket #110): a colleague handed three sub-tasks of one task to child sessions: one finished and checked, one failed and one
 * still waiting for a free member. Made when its screen is reached, as fixture runners take the jobs, so no earlier screen changes.
 */
async function delegationsRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const org = demo.actor.organizationId;
  brain.ensurePrincipal(org, "colleague", "human");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'operator',1,?,?)").run(demo.workspaceId, org, "colleague", demo.actor.actorId, brain.store.now());
  const colleague = { kind: "human" as const, actorId: "colleague", organizationId: org, workspaceId: demo.workspaceId, scopes: scopesForPrincipal(brain.store, "colleague", org, demo.workspaceId), authMethod: "session" as const, authGeneration: 1 };
  const cmd = async (actor: typeof demo.actor, type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const missionId = (await cmd(demo.actor, "mission.create", "baseline-del-create", { title: "Choose a supplier", intent: "Pick the cheaper supplier", successCriteria: ["A supplier is chosen"], autoStart: false })).resourceId ?? "";
  const planId = (await cmd(demo.actor, "plan.propose", "baseline-del-plan", { missionId, origin: "manual", tasks: [{ id: "compare", title: "Compare vendor prices", criteria: ["Prices are compared"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId ?? "";
  const version = ((await brain.executeQuery(demo.actor, { queryType: "missions.get", workspaceId: demo.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await cmd(demo.actor, "plan.confirm", "baseline-del-confirm", { planVersionId: planId }, version);
  const workItemId = (brain.store.workspaceDb(demo.workspaceId, org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
  const parent = (await cmd(colleague, "session.create", "baseline-del-parent", { workItemId, agentId: "task-worker", engineId: "fixture", task: "Compare vendor prices", budget: { maxTokens: 100000, maxMicroUsd: 0, maxTurns: 8 }, scope: { allowedPaths: [], prohibitedPaths: [], allowedTools: [] }, })).resourceId ?? "";
  const done = (await cmd(colleague, "session.delegate", "baseline-del-a", { parentSessionId: parent, task: "Summarise the three cheapest vendors" })).resourceId ?? "";
  const broken = (await cmd(colleague, "session.delegate", "baseline-del-b", { parentSessionId: parent, task: "Read the supplier register" })).resourceId ?? "";
  const list = () => delegationsOf(brain, demo.actor, demo.workspaceId, missionId);
  brain.workflows.completeStep(org, demo.workspaceId, (await list()).find((entry) => entry.delegationId === broken)!.run.runId!, "respond", { error: "The supplier register could not be reached" }, false);
  const runners = await enrollChildRunners(brain, demo.actor, governor.url, "baseline-child");
  await driveChildren(brain, runners, () => (brain.store.workspaceDb(demo.workspaceId, org).prepare("SELECT state FROM delegation_runs WHERE delegation_id=?").get(done) as { state: string }).state === "succeeded");
  await cmd(colleague, "session.delegate", "baseline-del-c", { parentSessionId: parent, task: "Draft the supplier shortlist" });
  return `/missions/${missionId}/delegations`;
}

/** The Live console on a session that stopped and left a checkpoint on `runnerId`, made when its screen is reached (ticket #101); each adds a mission and a stopped task. */
async function interruptedRoute(demo: Demo, governor: Fixture, runnerId: string, key: string, then?: (sessionId: string) => Promise<string>): Promise<string> {
  const { sessionId } = await interruptedSession(governor.app.brain, demo.actor, demo.workspaceId, runnerId, "Summarise the board papers", key);
  return `/w/operations/live?session=${(await then?.(sessionId)) ?? sessionId}`;
}

/** Two standing teams (ticket #130), made through the commands the Library sends; the three standing-team screens share them. */
let standingTeamsSeeded = false;
let webhooksSeeded = false;
/** Two webhook addresses (GitHub, ticket system) with a few deliveries, reached the way the providers reach them: signed requests to the routes. */
async function seedWebhooks(governor: Fixture, _page: Page, demo: Demo): Promise<void> {
  if (webhooksSeeded) return;
  webhooksSeeded = true;
  const secret = "visual-baseline-secret-0123456789";
  const create = async (key: string, kind: string) => (await governor.app.brain.executeCommand(demo.actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "webhook.create", idempotencyKey: key, payload: { kind, workspaceId: demo.workspaceId, secret } } as never, key)).receipt.resourceId!;
  const github = await create("vb-hook-github", "github");
  await create("vb-hook-ticket", "ticket");
  const send = async (event: string, delivery: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    await fetch(`${governor.url}/hooks/github/${github}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body });
  };
  const repository = { full_name: "acme/app", html_url: "https://github.com/acme/app" };
  await send("ping", "vb-1", { zen: "Design for failure." });
  await send("issues", "vb-2", { action: "opened", repository, issue: { number: 12, title: "Sign-in fails", html_url: "https://github.com/acme/app/issues/12", labels: [] } });
  await send("check_run", "vb-3", { action: "completed", repository, check_run: { name: "ci / test", conclusion: "success", pull_requests: [{ number: 9 }] } });
}
async function seedStandingTeams(governor: Fixture, _page: Page, demo: Demo): Promise<void> {
  if (standingTeamsSeeded) return;
  standingTeamsSeeded = true;
  const brain = governor.app.brain;
  const create = async (key: string, payload: Record<string, unknown>) => brain.executeCommand(demo.actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "standingTeam.create", workspaceId: demo.workspaceId, idempotencyKey: key, payload } as never, key);
  await create("vb-team-research", { name: "Research desk", description: "Reads sources, then checks the write-up", coordinatorMemberId: "analyst",
    members: [{ memberId: "analyst", role: "Analyst", agentId: "task-worker", engine: "fixture" }, { memberId: "checker", role: "Checker", agentId: "support-analyst", engine: "fixture" }] });
  await create("vb-team-solo", { name: "Solo writer", members: [{ memberId: "writer-solo", role: "Writer", agentId: "task-worker", engine: "fixture" }] });
}

/** A mission whose one-member plan is still a proposal, so its editor can copy a standing team in; made when its screen is reached. */
async function standingPlanRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const cmd = async (type: string, key: string, payload: Record<string, unknown>) => (await brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: demo.workspaceId, idempotencyKey: key, payload,
  } as never, key)).receipt;
  const missionId = (await cmd("mission.create", "baseline-standing-create", { title: "Plan the offsite", intent: "Plan the offsite", successCriteria: ["The plan is ready"], autoStart: false })).resourceId ?? "";
  await cmd("plan.propose", "baseline-standing-plan", { missionId, origin: "manual", team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }],
    tasks: [{ id: "venues", title: "Shortlist venues", criteria: ["Three venues are listed"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } }, { id: "agenda", title: "Draft the agenda", criteria: ["The agenda fits one day"], dependsOn: ["venues"] }] });
  return `/missions/${missionId}/plan`;
}

/** The Live console on a session a person paused at its turn boundary (ADR 0058), made when its screen is reached through commands and the runner protocol. */
async function pausedSessionRoute(demo: Demo, governor: Fixture): Promise<string> {
  const brain = governor.app.brain;
  const running = await runningSession(brain, demo.actor, demo.workspaceId, "runner-paused", "Draft the board summary", "vb-paused", PAUSABLE_FEATURES);
  await command(brain, demo.actor, demo.workspaceId, "session.pause", "vb-pause-now", { sessionId: running.sessionId });
  runnerReports(brain, running, "session-paused");
  return `/w/operations/live?session=${running.sessionId}`;
}

/** Missions and a Play with a clean record (#158): each earned one step, so their pages, Quality and the Play page show a suggestion. Made once, when the first of those screens is reached. */
let autonomyRecords: { missionId: string } | undefined;
async function seedAutonomyRecords(governor: Fixture, _page: Page, demo: Demo): Promise<void> {
  if (autonomyRecords) return;
  const ctx = autonomyContext(governor.app.brain, demo.actor.organizationId, demo.actor, demo.workspaceId);
  const missionId = await cleanMission(ctx, "vb-autonomy", 5, { autonomy: "supervised", title: "Weekly vendor review" });
  await cleanPlayMissions(ctx, "vb-autonomy-play", "checklist-runbook", 5);
  autonomyRecords = { missionId };
}

/** The agent-activity mission, made once when the first agent screen is reached. */
let agentActivity: Awaited<ReturnType<typeof seedAgentActivity>> | undefined;

const SCREENS: Array<{ id: string; route: (demo: Demo, governor: Fixture) => string | Promise<string>; heading: string | RegExp; testid?: string; waitFor?: string; /** Generated text (a trace id, an address with a random id and port, the minute a delivery arrived) that differs on every run: painted over in the shot. */ mask?: (page: Page) => Locator[]; prepare?: (governor: Parameters<typeof seedBrowserDemo>[1], page: Page, demo: Demo) => Promise<void>; after?: (page: Page) => Promise<void> }> = [
  { id: "missions", route: () => "/w/operations/missions", heading: "Missions" },
  { id: "mission-plan", route: (d) => `/missions/${d.seed.missionIds.active}/plan`, heading: "Stabilize authentication" },
  { id: "mission-board", route: (d) => `/missions/${d.seed.missionIds.active}/plan?view=board`, heading: "Stabilize authentication", waitFor: "work-board", after: async (page) => { await expect(page.getByTestId("work-board")).toBeVisible(); await expect(page.getByTestId("work-overdue")).toBeVisible(); } },
  { id: "mission-live", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication" },
  // The Brief with its Trace id opened (ticket #143): the mission trace id a person copies to find the mission in a trace backend.
  { id: "mission-brief-trace", mask: (page) => [page.locator(".brain-digest code")], route: (d) => `/missions/${d.seed.missionIds.active}/brief`, heading: "Stabilize authentication", after: async (page) => { await page.getByText("Trace id", { exact: true }).click(); await expect(page.getByRole("button", { name: "Copy full Trace id" })).toBeVisible(); await page.getByRole("button", { name: "Copy full Trace id" }).evaluate(place, "center"); } },
  { id: "plays", route: () => "/w/operations/plays?mode=catalog", heading: "Plays" },
  { id: "live", route: () => "/w/operations/live", heading: "Sessions & runs", testid: "console-rail" },
  { id: "logs", route: () => "/w/operations/logs", heading: "Logs" },
  { id: "outputs", route: () => "/w/operations/outputs", heading: "All results" },
  { id: "approvals", route: () => "/approvals", heading: "Approvals" },
  { id: "approval-review", route: (d) => `/approvals/${d.seed.approvalId}`, heading: "Approval review" },
  { id: "runners", route: () => "/runners", heading: "Runners" },
  { id: "today-fleet", route: () => "/w/operations/today", heading: "Today", after: async (page) => { const fleet = page.getByTestId("fleet-overview"); await expect(fleet).toBeVisible(); await expect(page.getByTestId("fleet-spend-today")).toBeVisible(); await fleet.evaluate(place, "center"); } },
  { id: "runner-detail", route: (d) => `/runners/${d.seed.runnerId}`, heading: "runner-demo" },
  { id: "settings-setup", route: () => "/settings?tab=setup", heading: "Setup" },
  { id: "settings-work", route: () => "/settings?tab=work", heading: "How work runs" },
  { id: "settings-health", route: () => "/settings?tab=health", heading: "Health", prepare: seedBackupRecords },
  { id: "settings-egress", route: () => "/settings?tab=work", heading: "How work runs", after: async (page) => { const egress = page.locator("[data-work-egress]"); await expect(egress).toBeVisible(); await egress.evaluate(place, "ifneeded"); } },
  { id: "settings-ceiling", route: () => "/settings?tab=work", heading: "How work runs", after: async (page) => { const ceiling = page.locator("[data-work-ceiling]"); await expect(ceiling).toBeVisible(); await ceiling.evaluate(place, "ifneeded"); } },
  { id: "settings-stop-all", route: () => "/settings?tab=work", heading: "How work runs", after: async (page) => { await page.getByRole("button", { name: "Stop all sessions…", exact: true }).click(); await expect(page.getByRole("dialog").getByRole("heading", { name: "Stop all sessions?" })).toBeVisible(); } },
  { id: "knowledge", route: () => "/w/operations/knowledge", heading: "Knowledge" },
  { id: "integrations", route: () => "/administration/integrations", heading: "Integrations" },
  { id: "integrations-connect", route: () => "/administration/integrations", heading: "Integrations", after: async (page) => { await page.getByRole("button", { name: "Connect remote", exact: true }).first().click(); await expect(page.getByRole("dialog").getByLabel(/^Git provider/)).toBeVisible(); } },
  { id: "mission-task-comments", route: (d) => `/missions/${d.seed.missionIds.active}/plan?item=${d.seed.workItems["in-progress"]}`, heading: "Comments", prepare: seedTaskComments, after: async (page) => { await page.getByRole("heading", { name: "Comments", level: 4 }).evaluate(place, "start"); } },
  { id: "mission-timeline", route: (d) => `/missions/${d.seed.missionIds.active}/timeline`, heading: "Stabilize authentication", prepare: seedTimelineEntries, after: async (page) => { const timeline = page.getByTestId("mission-timeline"); await expect(timeline).toBeVisible(); await timeline.evaluate(place, "start"); } },
  { id: "run-tool-calls", route: (d) => `/runs/${d.seed.run!.jobId}?tab=tool-calls`, heading: "Run inspector", prepare: seedRunToolCalls, waitFor: "run-tool-calls" },
  // A ticket trigger on the Schedules screen: its card, then the editor with the subject choice and the plan explanation (ticket #122).
  { id: "schedules-subject-trigger", route: () => "/w/operations/schedules", heading: "Schedules", prepare: seedSubjectTrigger, after: async (page) => { await expect(page.locator("article").filter({ hasText: "Draft a reply to every new ticket" }).getByTestId("subject-plan-summary")).toBeVisible(); } },
  { id: "schedules-subject-editor", route: () => "/w/operations/schedules", heading: "Schedules", after: async (page) => {
    await page.getByRole("button", { name: "New schedule", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Trigger", { exact: true }).click();
    await page.getByRole("option", { name: "When a new ticket or incident arrives", exact: true }).click();
    await expect(sheet.getByTestId("subject-plan")).toBeVisible();
  } },
  // Eval cases come late, because the cases are recorded by sending tasks back, which adds missions the screens above would show.
  { id: "eval-cases", route: () => "/w/operations/quality/cases", heading: "Eval cases", prepare: seedEvalCases },
  // The plan editor open on a confirmed plan's team: its mission adds a work item only the screens after it could list.
  { id: "mission-plan-editor", route: planEditorRoute, heading: "Prepare the vendor review", after: async (page) => { await page.getByRole("button", { name: /^See the confirmed plan/ }).click(); await page.getByRole("button", { name: "Edit steps", exact: true }).first().click(); await expect(page.getByTestId("plan-team")).toBeVisible(); await expect(page.getByTestId("plan-step-assignment").first()).toBeVisible(); } },
  // The board across missions, after the plan-editor mission so it holds the work of several missions.
  { id: "workspace-board", route: () => "/w/operations/board", heading: "Board", after: async (page) => { await expect(page.getByTestId("work-board")).toBeVisible(); await expect(page.getByTestId("board-count")).toBeVisible(); } },
  // A mission from the coordinator Play (ticket #108): its Team tab marks the coordinator and says what it does not do.
  { id: "mission-team-coordinator", route: coordinatedTeamRoute, heading: "Research the offsite venues", after: async (page) => { await expect(page.locator("[data-coordinator='lead']")).toBeVisible(); await page.locator("[data-coordinator-note]").evaluate(place, "end"); } },
  // Last of all: the sign-off mission adds an attention item every earlier screen would count in its bell.
  { id: "mission-signoff", route: signOffRoute, heading: "Compile the quarterly report", waitFor: "mission-signoff" },
  // A pull request an approved change opened, on its task and on its approval: made after the other screens but before the push ones (those stay last), because its approval and connection join earlier lists.
  { id: "mission-task-pull-request", route: (d) => `/missions/${d.seed.missionIds.active}/plan?item=${d.seed.workItems["review"]}`, heading: "Pull requests", prepare: seedPullRequestRecord, after: async (page) => { const section = page.getByTestId("pull-requests"); await expect(section.getByTestId("pull-request-state")).toHaveText("Open"); await section.evaluate(place, "ifneeded"); } },
  { id: "approval-review-pull-request", route: () => `/approvals/${pullRequestRecord!.approvalId}`, heading: "Approval review", after: async (page) => { const section = page.getByTestId("pull-requests"); await expect(section.getByTestId("pull-request-state")).toHaveText("Open"); await section.evaluate(place, "ifneeded"); } },
  // An approval of a file change with its mission, task, run, diff and rollback (ticket #120): made here because its approval joins every later list.
  { id: "approval-review-change", route: () => `/approvals/${changeApproval!.approvalId}`, heading: "Approval review", prepare: seedChangeApprovalRecord, after: async (page) => { await expect(page.locator("[data-approval-diff]")).toContainText("+memory: 768m"); await expect(page.locator("[data-approval-rollback=declared]")).toBeVisible(); } },
  // Resume from checkpoint (tickets #101, #129), before the push screens (those stay last) because each screen adds a mission and a stopped task to the attention items: the failed session
  // that any eligible runner could resume, the one no runner is left to resume, and the new session that says which checkpoint it started from.
  { id: "console-resume-offered", route: (d, g) => interruptedRoute(d, g, "runner-office", "vb-resume-offered"), heading: "Sessions & runs", testid: "console-rail", after: async (page) => { await expect(page.getByRole("button", { name: "Resume from checkpoint", exact: true })).toBeVisible(); } },
  { id: "console-resume-unavailable", route: (d, g) => interruptedRoute(d, g, "runner-retired", "vb-resume-gone", async (sessionId) => {
    // Every runner this fleet has is taken out of service, the one that took the checkpoint included: nothing could continue it.
    for (const { id } of g.app.brain.store.control.prepare("SELECT id FROM runners WHERE deregistered_at_ms IS NULL").all() as Array<{ id: string }>) await command(g.app.brain, d.actor, d.workspaceId, "runner.control", `vb-resume-retire-${id}`, { runnerId: id, action: "deregister", reason: "retired" });
    return sessionId;
  }), heading: "Sessions & runs", testid: "console-rail", after: async (page) => { await expect(page.getByTestId("resume-unavailable")).toBeVisible(); } },
  { id: "console-resumed", route: (d, g) => interruptedRoute(d, g, "runner-resumed", "vb-resumed", async (sessionId) => (await command(g.app.brain, d.actor, d.workspaceId, "session.resume", "vb-resume-now", { sessionId })).resourceId!), heading: "Sessions & runs", testid: "console-rail", after: async (page) => { await expect(page.getByTestId("resumed-from")).toBeVisible(); } },
  // A question a team member asked a person (ticket #109), before the push screens (those stay last) because it adds an attention item: the mission's Live tab, then the composer open on it.
  { id: "mission-question", route: questionRoute, heading: "Compile the quarterly report figures", waitFor: "mission-questions" },
  { id: "mission-question-answer", route: questionRoute, heading: "Compile the quarterly report figures", after: async (page) => { await page.getByTestId("mission-question").getByRole("button", { name: "Answer", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Answer a question" })).toBeVisible(); } },
  { id: "mission-delegations", route: delegationsRoute, heading: "Choose a supplier", waitFor: "delegations" },
  // Push: the offer on Needs you (this device could receive notifications and was never asked), then the settings control once it is on.
  // Where a mission's usage went (#111): it adds spend to the active mission, which the screens before it would show in their totals.
  { id: "mission-usage-breakdown", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication", prepare: seedAttributedUsage, after: async (page) => { await page.getByTestId("usage-breakdown").getByText("Where the usage went", { exact: true }).click(); await expect(page.getByTestId("usage-by-member")).toContainText("writer"); await page.getByTestId("usage-breakdown").evaluate(place, "center"); } },
  // Spend over time (#112): earlier days of spend for the active mission, then the workspace chart with cost per verified task, and the mission's own chart.
  { id: "missions-spend-history", route: () => "/w/operations/missions", heading: "Missions", prepare: seedSpendHistory, after: async (page) => { await page.getByTestId("workspace-spend-history").getByText("Spend over time", { exact: true }).click(); await expect(page.getByTestId("workspace-spend-history").getByTestId("daily-bar")).toHaveCount(30); await page.getByTestId("verified-cost").getByText("Cost per verified task", { exact: true }).click(); await expect(page.getByTestId("verified-by-agent")).toContainText("task-worker"); await page.getByTestId("workspace-spend-history").evaluate(place, "start"); } },
  { id: "mission-spend-history", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication", after: async (page) => { await page.getByTestId("mission-spend-history").getByText("Spend over time", { exact: true }).click(); await expect(page.getByTestId("mission-spend-history").getByTestId("daily-bar")).toHaveCount(30); await page.getByTestId("mission-spend-history").evaluate(place, "center"); } },
  // Agent page and team-member panel (ticket #113): a runner took a two-member team's tasks, one attempt failed and one is working. The mission adds a parked task to Needs you, which the push screens after it count.
  { id: "agents-list", route: () => "/w/operations/library/agents", heading: "Agents", prepare: async (governor, _page, demo) => { agentActivity ??= await seedAgentActivity(governor.app.brain, demo.actor, demo.workspaceId, "vb-agents"); }, after: async (page) => { await expect(page.getByTestId("agent-list")).toBeVisible(); await expect(page.locator("[data-agent=task-worker]").getByTestId("activity-status")).toBeVisible(); } },
  { id: "agent-page", route: () => "/w/operations/library/agents/task-worker", heading: "Task worker", after: async (page) => { await expect(page.getByTestId("figure-cost-value")).toContainText("tokens"); await expect(page.getByTestId("recent-run").first()).toBeVisible(); } },
  { id: "mission-team-member", route: () => `/missions/${agentActivity!.missionId}/team?member=writer`, heading: "Draft and review the vendor summary", after: async (page) => { await expect(page.getByTestId("member-panel")).toBeVisible(); await expect(page.getByTestId("figure-cost-value")).toContainText("tokens"); await page.getByTestId("member-panel").evaluate(place, "start"); } },
  // Chat identities (ticket #123): who a signed chat message is from, linked to a member, under People.
  { id: "settings-chat-identities", route: () => "/settings?tab=people", heading: "People", prepare: seedChatIdentities, after: async (page) => { const identities = page.locator("[data-chat-identities]"); await expect(identities).toBeVisible(); await expect(identities.locator("[data-chat-identity]")).toHaveCount(2); await identities.evaluate(place, "ifneeded"); } },
  // Handing a mission to a teammate (#117): the mission's menu, then the dialog with a teammate chosen. It adds one member, so it comes after every screen that lists people.
  { id: "mission-handover", route: (d) => `/missions/${d.seed.missionIds.active}/live`, heading: "Stabilize authentication", prepare: seedTeammate, after: async (page) => { await page.getByRole("button", { name: "More", exact: true }).click(); await page.getByRole("menuitem", { name: "Hand this mission to someone else" }).click(); const dialog = page.getByRole("dialog", { name: "Hand this mission over" }); await dialog.getByRole("combobox", { name: "New owner" }).click(); await page.getByRole("option", { name: /Dana Cole/ }).click(); await expect(dialog.getByRole("button", { name: "Hand over", exact: true })).toBeEnabled(); } },
  // Knowledge whose source document got a newer version (#133): it says what changed and offers Re-confirm and Withdraw. It adds a document, so it comes before only the push screens.
  { id: "knowledge-stale", route: () => "/w/operations/knowledge", heading: "Knowledge", prepare: seedStaleKnowledgeEntry, after: async (page) => { await expect(page.getByTestId("learned-stale")).toBeVisible(); await expect(page.getByTestId("learned-reconfirm")).toBeVisible(); } },
  { id: "settings-model-routes", route: () => "/settings?tab=work", heading: "How work runs", prepare: async (governor, _page, demo) => {
    const route = (routeId: string, extra: Record<string, unknown>) => ({ routeId, enabled: true, vendor: "Acme", keyRef: `${routeId}-key`, model: `${routeId}-large`, baseUrl: `https://${routeId}.acme.example/v1`, costTier: "standard", inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000, ...extra });
    await governor.app.brain.executeCommand(demo.actor, { contractVersion: "brain.command/v1", commandId: "cmd-vb-routes", commandType: "workspace.modelRoutes.set", workspaceId: demo.workspaceId, idempotencyKey: "vb-routes",
      payload: { routes: [route("primary", { viaGateway: true }), route("backup", { costTier: "low", enabled: false, inputMicroUsdPerMTok: 50_000, outputMicroUsdPerMTok: 200_000 })] } } as never, "vb-routes");
  }, after: async (page) => { const routes = page.locator("[data-work-hosted]"); await expect(routes.locator("[data-work-route='2']")).toBeVisible(); await routes.evaluate(place, "ifneeded"); } },
  // Standing teams (ticket #130), before the push screens (those stay last): the Library's Teams place, its create form, a plan editor using a team, and a Play start choosing one.
  { id: "library-teams", route: () => "/w/operations/library/teams", heading: "Teams", prepare: seedStandingTeams, after: async (page) => { await expect(page.getByTestId("standing-team")).toHaveCount(2); } },
  { id: "library-teams-form", route: () => "/w/operations/library/teams", heading: "Teams", prepare: seedStandingTeams, after: async (page) => { await page.getByRole("button", { name: "New team", exact: true }).first().click(); const sheet = page.getByRole("dialog"); await sheet.getByLabel(/^Name/).fill("Support rota"); await sheet.getByTestId("plan-team").getByLabel("Role", { exact: true }).fill("Triage"); await sheet.getByTestId("plan-team").getByRole("button", { name: "Add to team", exact: true }).click(); await expect(sheet.getByTestId("plan-team-member")).toHaveCount(1); } },
  { id: "mission-plan-standing-team", route: standingPlanRoute, heading: "Plan the offsite", prepare: seedStandingTeams, after: async (page) => { await page.getByRole("button", { name: "Edit steps", exact: true }).first().click(); const standing = page.getByRole("dialog").getByTestId("plan-standing-team"); await standing.getByLabel("Standing team", { exact: true }).click(); await page.getByRole("option", { name: /Research desk/ }).click(); await standing.getByRole("button", { name: "Add its members", exact: true }).click(); await expect(standing.getByTestId("plan-standing-done")).toBeVisible(); } },
  { id: "start-standing-team", route: () => "/w/operations/missions/new", heading: "New mission", prepare: seedStandingTeams, after: async (page) => { await page.getByRole("dialog").getByTestId("play-chips").getByRole("button").first().click(); await expect(page.getByTestId("start-standing-team")).toBeVisible(); } },
  // A session a person paused (ADR 0058): it adds a running session, so it comes after the screens that list sessions and before the push screens (those stay last).
  { id: "console-session-paused", route: pausedSessionRoute, heading: "Sessions & runs", testid: "console-rail", after: async (page) => { await expect(page.getByTestId("continue-session")).toBeVisible(); await expect(page.getByTestId("pause-note")).toBeVisible(); } },
  // Best of several (#127): a task's candidates side by side, then the plan editor's candidates for a step. They add a mission and release, so they come after the screens that list missions and before the push screens.
  { id: "mission-candidates", route: candidatesRoute, heading: "Write the one-page brief", after: async (page) => { const panel = page.getByTestId("work-candidates"); await expect(panel.getByTestId("work-candidate")).toHaveCount(3); await expect(panel).toContainText("Suggested"); await panel.evaluate(place, "ifneeded"); } },
  { id: "mission-plan-candidates", route: candidatePlanRoute, heading: "Compare three briefs, planned", after: async (page) => { await page.getByRole("button", { name: /^See the confirmed plan/ }).click(); await page.getByRole("button", { name: "Edit steps", exact: true }).first().click(); await expect(page.getByTestId("plan-step-candidates").first()).toContainText("Best of 3"); await page.getByTestId("plan-step-candidates").first().evaluate(place, "ifneeded"); } },
  // Who can read what Brain learned (#135): the review inbox with a record for the workspace, one kept private with a request for the team and one the team reads. It adds knowledge, so it comes after every screen that counts it.
  { id: "knowledge-scopes", route: () => "/w/operations/knowledge/review", heading: "Review inbox", prepare: seedKnowledgeScopes, waitFor: "knowledge-inbox", after: async (page) => { await expect(page.getByTestId("knowledge-inbox")).toContainText("Readable by: Only its author"); } },
  // Autonomy suggestions (#158): a mission, a Play and the Quality page each show what a clean record earned, with its figures and definitions. They add finished missions, so they come after every screen that counts them and before the push screens.
  { id: "mission-autonomy-suggestion", route: () => `/missions/${autonomyRecords!.missionId}/live`, heading: "Weekly vendor review", prepare: seedAutonomyRecords, after: async (page) => { const card = page.getByTestId("autonomy-suggestion"); await expect(card).toHaveCount(1); await expect(card.getByTestId("autonomy-figure")).toHaveCount(5); await card.evaluate(place, "start"); } },
  { id: "play-autonomy-suggestion", route: () => "/plays/checklist-runbook", heading: "Write a checklist or runbook", prepare: seedAutonomyRecords, after: async (page) => { const card = page.getByTestId("autonomy-suggestion"); await expect(card).toHaveCount(1); await card.evaluate(place, "start"); } },
  { id: "quality-autonomy-suggestion", route: () => "/quality", heading: "Quality", prepare: seedAutonomyRecords, after: async (page) => { await expect(page.getByTestId("autonomy-suggestion")).toHaveCount(2); await page.getByTestId("autonomy-suggestions").evaluate(place, "start"); } },
  // The run page's Why tab (ticket #144): it adds a mission, a run and a runner, so it comes after every screen that counts them and before the push screens (those stay last).
  // Administration > Integrations with signed webhook addresses and their last deliveries (ticket #138): status only, no secret.
  { id: "admin-webhooks", mask: (page) => [page.getByTestId("webhook-url"), page.getByText(/· Added \d/), page.getByTestId("webhook-deliveries").locator("span.text-ink-gray-6")], route: () => "/administration/integrations", heading: "Signed webhooks", prepare: seedWebhooks, waitFor: "webhooks", after: async (page) => { await expect(page.getByTestId("webhook-endpoint")).toHaveCount(2); await expect(page.getByTestId("webhook-deliveries").first()).toBeVisible(); } },
  { id: "run-why", route: whyRoute, heading: "Run inspector", waitFor: "why-choices" },
  { id: "today-push-offer", route: () => "/w/operations/today", heading: "Today", prepare: async (_governor, page) => pushDevice(page, false), after: async (page) => { const offer = page.getByTestId("push-offer"); await expect(offer).toBeVisible(); await offer.evaluate(place, "ifneeded"); } },
  { id: "settings-push-device", route: () => "/settings?tab=security", heading: "Security", prepare: async (_governor, page) => pushDevice(page, true), after: async (page) => { const control = page.getByTestId("push-device"); await expect(control).toContainText("Notifications are on for this device."); await control.evaluate(place, "ifneeded"); } },
];

async function seedChatIdentities(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Demo): Promise<void> {
  await command(governor.app.brain, demo.actor, demo.workspaceId, "chatIdentity.set", "vb-chat-slack", { provider: "slack", chatUserId: "U024BE7LH", principalId: demo.actor.actorId });
  await command(governor.app.brain, demo.actor, demo.workspaceId, "chatIdentity.set", "vb-chat-teams", { provider: "teams", chatUserId: "7c1e2d0a-5f4b-4a53-9a31-0b2c7d6e8f90", principalId: demo.actor.actorId });
}
/** One published write-up of the closed mission whose source document then got a new version; added once, when its screen is reached. */
let staleKnowledge = false;
async function seedStaleKnowledgeEntry(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  if (staleKnowledge) return;
  staleKnowledge = true;
  await seedStaleKnowledge(governor.app.brain, demo.actor, demo.workspaceId, { key: "vb-stale", missionId: demo.seed.missionIds.closed, title: "Vendor seat prices", content: "Vendor A is cheapest per seat on a one-year term; Vendor B needs a three-year term.", documentTitle: "Vendor price list" });
}

/** A teammate who can work on missions (the one hand-over screen); added once, when its screen is reached. */
let teammate = false;
async function seedTeammate(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  if (teammate) return;
  teammate = true;
  const brain = governor.app.brain;
  seedHuman(brain, demo.actor.organizationId, "dana");
  brain.store.control.prepare('UPDATE "user" SET name=? WHERE id=?').run("Dana Cole", "dana");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'operator',1,?,?)").run(demo.workspaceId, demo.actor.organizationId, "dana", demo.actor.actorId, brain.store.now());
}

/** Health with a fresh backup and a passed restore test, recorded the way the host's jobs record them; `restoreBackupRecords` puts the environment back. */
const BACKUP_ENV = ["BRAIN_BACKUP_STAMP_FILE", "BRAIN_RESTORE_TEST_FILE"] as const;
const backupEnvBefore = Object.fromEntries(BACKUP_ENV.map((key) => [key, process.env[key]]));
let backupRecordsDir: string | undefined;
async function seedBackupRecords(governor: Parameters<typeof seedBrowserDemo>[1]): Promise<void> {
  backupRecordsDir = mkdtempSync(join(tmpdir(), "brain-visual-backups-"));
  writeFileSync(join(backupRecordsDir, "last-backup-ok"), String(Math.floor(Date.now() / 1000) - 5 * 3600));
  writeFileSync(join(backupRecordsDir, "last-restore-test.json"), JSON.stringify({ ok: true, backup: "brain-20261110.tar.enc", databases: 4, seconds: 42, at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
  process.env["BRAIN_BACKUP_STAMP_FILE"] = join(backupRecordsDir, "last-backup-ok");
  process.env["BRAIN_RESTORE_TEST_FILE"] = join(backupRecordsDir, "last-restore-test.json");
  // The seeded runner reports in only for a moment after the seed; Health lists runners and the launcher only while one is online, so keep it online for this screen.
  governor.app.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=?").run(governor.app.brain.store.now());
  await governor.app.brain.runEngineProbes((async () => new Response("{}")) as unknown as typeof fetch);
}
function restoreBackupRecords(): void {
  for (const key of BACKUP_ENV) {
    if (backupEnvBefore[key] === undefined) delete process.env[key];
    else process.env[key] = backupEnvBefore[key];
  }
  if (backupRecordsDir) rmSync(backupRecordsDir, { recursive: true, force: true });
}

/** A person's comment on a task and the correction of it, through the same command the screen sends. */
async function seedTaskComments(governor: Parameters<typeof seedBrowserDemo>[1], page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  const workItemId = demo.seed.workItems["in-progress"];
  const comment = async (key: string, payload: Record<string, unknown>): Promise<string> => (await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workItem.comment", workspaceId: "operations", idempotencyKey: key, payload: { workItemId, ...payload } } as never, key)).receipt.resourceId ?? "";
  const first = await comment("vb-comment-1", { text: "Use the existing sessions table, not a new one." });
  await comment("vb-comment-2", { text: "Use the existing sessions table and keep its index; do not add a new one.", correctionOf: first });
}

/** A decision and a message on the active mission, through the commands the screens send, so its timeline has more than plans and runs. */
async function seedTimelineEntries(governor: Parameters<typeof seedBrowserDemo>[1], page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  const send = async (key: string, commandType: string, payload: Record<string, unknown>): Promise<void> => {
    await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "operations", idempotencyKey: key, payload } as never, key);
  };
  const missionId = demo.seed.missionIds.active;
  const brief = (await brain.executeQuery(actor, { queryType: "missions.brief", workspaceId: "operations", resourceId: missionId })) as unknown as { snapshot: { version: number } };
  await send("vb-timeline-decision", "decision.accept", { missionId, baseVersion: brief.snapshot.version, statement: "Check the session cookie before anything else", source: { kind: "human" } });
  await send("vb-timeline-message", "mission.message.send", { missionId, recipient: { kind: "mission" }, body: "Start with the login redirect." });
}

/** Settled spend of the active mission by two team members on two agents, one on a local model and one hosted, plus the advisory judge's call (the demo has no runner behind its seeded work). */
async function seedAttributedUsage(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const brain = governor.app.brain;
  const db = brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const now = brain.store.now();
  const row = db.prepare(`INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,cached_input_tokens,accounting,source,agent_id,member_id,engine_id,model_id,created_at_ms,settled_at_ms)
    VALUES (?,?,?,0,?,?,?,?,'final-total',?,?,?,?,?,?,?)`);
  const missionId = demo.seed.missionIds.active;
  row.run("vb-usage-1", missionId, "vb-usage-run-1", 0, 41_000, 2_100, 6_000, "attempt", "task-worker", "writer", "pi", "qwen-local", now, now);
  row.run("vb-usage-2", missionId, "vb-usage-run-2", 182_000, 9_500, 1_200, 0, "attempt", "operations-assistant", "reviewer", "pi", "acme-hosted", now, now);
  row.run("judge:vb:c1", missionId, "judge:vb", 210, 1_000, 100, 0, "judge", null, null, null, "acme-hosted", now, now);
}

/** Spend of the active mission on earlier days (1 to 21 days ago, two agents) so the daily chart has a shape; the demo has no runner behind its seeded work. */
async function seedSpendHistory(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const brain = governor.app.brain;
  const db = brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const now = brain.store.now();
  const row = db.prepare(`INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,cached_input_tokens,accounting,source,agent_id,member_id,engine_id,model_id,created_at_ms,settled_at_ms)
    VALUES (?,?,?,0,?,?,?,0,'final-total','attempt',?,?,'pi','acme-hosted',?,?)`);
  const days: Array<[number, number, string]> = [[1, 120_000, "task-worker"], [2, 310_000, "operations-assistant"], [3, 80_000, "task-worker"], [6, 450_000, "operations-assistant"], [7, 90_000, "task-worker"], [11, 230_000, "task-worker"], [15, 60_000, "operations-assistant"], [21, 170_000, "task-worker"]];
  for (const [index, [daysAgo, microUsd, agent]] of days.entries()) row.run(`vb-history-${index}`, demo.seed.missionIds.active, `vb-history-run-${index}`, microUsd, 3_000, 400, agent, agent === "task-worker" ? "writer" : "reviewer", now - daysAgo * 86_400_000, now - daysAgo * 86_400_000);
}

/** Two calls of the seeded run, recorded the way the Governor records a runner's tool events (the seeded run has no runner behind it). */
async function seedRunToolCalls(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Awaited<ReturnType<typeof seedBrowserDemo>>): Promise<void> {
  const run = demo.seed.run!;
  const insert = governor.app.brain.store.control.prepare("INSERT INTO tool_calls(attempt_id, proposal_id, organization_id, workspace_id, run_id, tool_id, proposed_at, failed, finished_at, failure_message) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const at = (offsetMs: number) => new Date(demo.seededAtMs + offsetMs).toISOString();
  insert.run("attempt-demo", "demo-call-1", demo.actor.organizationId, "operations", run.runId, "documents.read", at(1_000), 0, at(1_400), null);
  insert.run("attempt-demo", "demo-call-2", demo.actor.organizationId, "operations", run.runId, "web.fetch", at(2_000), 1, at(2_300), "host example.com is not on this tool's allowlist");
}

/** A ticket trigger, made through the command the Schedules screen sends. */
async function seedSubjectTrigger(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Demo): Promise<void> {
  await governor.app.brain.executeCommand(demo.actor, {
    contractVersion: "brain.command/v1", commandId: "cmd-vb-subject-trigger", commandType: "automation.upsert", workspaceId: demo.workspaceId, idempotencyKey: "vb-subject-trigger",
    payload: { title: "Draft a reply to every new ticket", target: { kind: "play", id: "support-reply-draft" }, trigger: { kind: "subject", subjectKind: "ticket" } },
  } as never, "vb-subject-trigger");
}

async function seedEvalCases(governor: Parameters<typeof seedBrowserDemo>[1], page: Page): Promise<void> {
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }), "operations")).actor;
  await sendTaskBack(brain, actor, "operations", { key: "vb1", title: "Quarterly churn report", finding: "Cause two had no cited source" });
  await sendTaskBack(brain, actor, "operations", { key: "vb2", title: "Refund summary", finding: "The refund total does not add up" });
}

/** Three published write-ups at three scopes, made when their screen is reached: the producer is the demo owner, so the card offers them the author's choices. */
async function seedKnowledgeScopes(governor: Fixture, _page: Page, demo: Demo): Promise<void> {
  const db = governor.app.brain.store.workspaceDb(demo.workspaceId, demo.actor.organizationId);
  const at = Date.now() - 3 * 86_400_000;
  const insert = db.prepare(`INSERT INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,title,mission_id,producer_id,provenance_json,reviewed_by,reviewed_at_ms,scope,scope_requested,created_at_ms,updated_at_ms)
    VALUES (?,?,'mission-knowledge','published','internal',?,1,?,?,?,'[]',?,?,?,?,?,?)`);
  const rows: Array<[string, string, string, "private" | "team" | "workspace", "team" | "workspace" | null]> = [
    ["vb-scope-workspace", "Vendor onboarding checklist", "Every vendor is checked against the approved list before the first purchase order.", "workspace", null],
    ["vb-scope-private", "Draft pricing notes", "Early notes on how the pricing options compare; not ready for anyone else yet.", "private", "team"],
    ["vb-scope-team", "Rollout runbook", "The staged rollout order the team settled on, with the rollback step for each stage.", "team", null],
  ];
  for (const [index, [id, title, content, scope, requested]] of rows.entries()) {
    insert.run(id, "sha256:" + String(index + 1).repeat(64), content, title, demo.seed.missionIds.closed, demo.actor.actorId, demo.actor.actorId, at, scope, requested, at + index, at + index);
  }
}

/** The pull request record the last two screens show; the remote it was opened on is closed after the test. */
let pullRequestRecord: Awaited<ReturnType<typeof seedPullRequest>> | undefined;
async function seedPullRequestRecord(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Demo): Promise<void> {
  pullRequestRecord = await seedPullRequest(governor.app.brain, demo.actor, demo.workspaceId, { runId: "demo-run-review", key: "vb-pr" });
}

/** The approval of a file change the screen above shows: its task is the seeded one in progress, so the screen names a mission, a task and a run. */
let changeApproval: Awaited<ReturnType<typeof seedChangeApproval>> | undefined;
async function seedChangeApprovalRecord(governor: Parameters<typeof seedBrowserDemo>[1], _page: Page, demo: Demo): Promise<void> {
  changeApproval = await seedChangeApproval(governor.app.brain, demo.actor, demo.workspaceId, { runId: "demo-run-progress", key: "vb-change" });
}

test.afterEach(async () => { globalThis.Date = RealDate; standingTeamsSeeded = false; webhooksSeeded = false; autonomyRecords = undefined; questionMission = undefined; restoreBackupRecords(); await pullRequestRecord?.cleanup(); pullRequestRecord = undefined; });

test("key screens match their visual baselines", async ({ page, governor }) => {
  test.setTimeout(900_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const now = pinClock();
  const demo = await seedBrowserDemo(page, governor);
  // One workspace is built up screen by screen (later screens count what earlier ones made), so the screens run in order in one test; a screen that does not match or cannot be reached is recorded and the rest still run.
  for (const screen of SCREENS.filter((entry) => !process.env["VB_ONLY"] || process.env["VB_ONLY"].split(",").includes(entry.id))) {
    try {
      await screen.prepare?.(governor, page, demo);
      await quiesce(governor.app.brain);
      await page.clock.setFixedTime(now());
      await page.goto(`${governor.url}${await screen.route(demo, governor)}`);
      const landmark = screen.testid
        ? page.getByTestId(screen.testid).getByRole("heading", { name: screen.heading })
        : page.getByRole("heading", { name: screen.heading }).first();
      await expect(landmark.first()).toBeVisible({ timeout: 20_000 });
      // A screen with a named region is shot scrolled to it, so the region itself is what the baseline holds.
      if (screen.waitFor) {
        await expect(page.getByTestId(screen.waitFor)).toBeVisible({ timeout: 20_000 });
        await page.getByTestId(screen.waitFor).evaluate(place, "center");
      }
      await screen.after?.(page);
      await settle(page);
    } catch (error) {
      expect.soft(String(error instanceof Error ? error.message : error).split("\n")[0], `${screen.id} could not be reached`).toBe("");
      continue;
    }
    await expect.soft(page, screen.id).toHaveScreenshot(`${screen.id}.png`, { ...(screen.mask ? { mask: screen.mask(page) } : {}), maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  }
});
