import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { ActorContext, Mission } from "@brain/contracts";
import { totpCode } from "../support/totp";
import { approvalSubjectDigest, type JsonValue } from "../../packages/contracts/src/index";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * The Needs you queue on Today (#51): every blocking item can be decided where it
 * stands, with the same scopes and step-up as the full screens. A person without
 * the scope still sees the item and is told who can act.
 */
test.use({ requireTwoFactor: true });
const DIGEST = `sha256:${"a".repeat(64)}`;
const shot = async (page: Page, name: string) => { if (process.env["TODAY_SHOTS"]) await page.screenshot({ path: `${process.env["TODAY_SHOTS"]}/${name}-${page.viewportSize()?.width}.png`, fullPage: true }); };

test("approve, reject a plan, confirm a plan, retry parked work and sign off a verdict, all from Today", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Queue organization");
  await page.getByLabel(/^Email/).fill("queue@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Authenticator setup" })).toBeVisible();
  await page.getByLabel(/^Confirm password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  const link = page.getByRole("link", { name: "Keyrus Brain to your authenticator", exact: true });
  await expect(link).toBeVisible();
  const secret = new URL((await link.getAttribute("href"))!).searchParams.get("secret")!;
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(page.getByRole("region", { name: "Authenticator setup" })).toHaveCount(0);

  const brain = governor.app.brain;
  const cookies = await page.context().cookies();
  const actor: ActorContext = (await brain.resolveActor(new Headers({ cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-queue", slug: "queue" });
  const ws: ActorContext = { ...actor, workspaceId: "ws-queue", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-queue") };
  const db = brain.store.workspaceDb("ws-queue", actor.organizationId);
  const cmd = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-queue", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const mission = async (id: string): Promise<Mission> => ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-queue", resourceId: id })) as unknown as { snapshot: Mission }).snapshot;
  const task = (title: string) => ({ id: "t", title, criteria: ["The note exists"], dependsOn: [] });
  const create = async (key: string, title: string) => (await cmd("mission.create", `${key}-create`, { title, intent: `${title} intent`, successCriteria: ["done"], autoStart: false })).resourceId ?? "";
  const propose = async (key: string, missionId: string, title: string) => (await cmd("plan.propose", `${key}-plan`, { missionId, origin: "manual", summary: `Plan for ${title}`, tasks: [task(`${title} task`)] })).resourceId ?? "";

  // 1. An approval, 2. two plan proposals, 3. a parked task, 4. a verified mission waiting to be closed.
  brain.ensurePrincipal(actor.organizationId, "requester-1", "human");
  const subject = { organizationId: actor.organizationId, workspaceId: "ws-queue", operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST }, inputDigest: DIGEST,
    target: { targetId: "t-queue", environmentId: "prod", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), nonce: "queue-n1" };
  const subjectDigest = approvalSubjectDigest(subject as unknown as JsonValue);
  brain.store.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES ('apr-queue-1', ?, 'ws-queue', 'requester-1', ?, ?, 'pending', ?, ?)`).run(actor.organizationId, subjectDigest, JSON.stringify(subject), Date.now() + 3_600_000, Date.now());

  const confirmId = await create("confirm", "Venue shortlist");
  const confirmPlan = await propose("confirm", confirmId, "Venue shortlist");
  const rejectId = await create("reject", "Vendor review");
  const rejectPlan = await propose("reject", rejectId, "Vendor review");

  const parkedId = await create("parked", "Parked mission");
  const parkedPlan = await propose("parked", parkedId, "Parked mission");
  await cmd("plan.confirm", "parked-confirm", { planVersionId: parkedPlan }, (await mission(parkedId)).version);
  const parkedItem = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(parkedId) as { id: string };
  db.prepare("UPDATE work_items SET state='blocked', parked=1, parked_diagnostic='The model could not reach the source three times', blocked_reason='Parked after 3 failed attempts', title='Collect the quotes' WHERE id=?").run(parkedItem.id);

  const verdictId = await create("verdict", "Quarterly note");
  const verdictPlan = await propose("verdict", verdictId, "Quarterly note");
  await cmd("plan.confirm", "verdict-confirm", { planVersionId: verdictPlan }, (await mission(verdictId)).version);
  const verdictItem = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(verdictId) as { id: string };
  db.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, verdictItem.id);
  await cmd("mission.proposeCompletion", "verdict-propose", { missionId: verdictId }, (await mission(verdictId)).version);
  const bundle = ((await brain.executeQuery(ws, { queryType: "missionBundles.latest", workspaceId: "ws-queue", resourceId: verdictId })) as unknown as { snapshot: { digest: string } }).snapshot;
  await cmd("mission.verdict.record", "verdict-record", { missionId: verdictId, bundleDigest: bundle.digest, outcome: "verified" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${governor.url}/w/ws-queue/today`);
  const queue = page.getByTestId("needs-you");
  // Today shows the first three, with the rest one click away ("N more").
  await expect(queue.getByTestId("needs-you-item")).toHaveCount(3, { timeout: 30_000 });
  const expandQueue = async () => { await expect(queue.getByTestId("needs-you-item").first()).toBeVisible({ timeout: 30_000 }); const more = page.getByRole("button", { name: "3 more", exact: true }); if (await more.count()) await more.click(); };
  await expandQueue();
  await expect(queue.getByTestId("needs-you-item")).toHaveCount(6, { timeout: 30_000 });
  // The order is the existing attention tiers: approval, then plans and parked work, then the verdict.
  const kinds = await queue.getByTestId("needs-you-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")));
  expect(kinds[0]).toBe("approval");
  expect(kinds[1]).toBe("needs-attention"); // the mission whose only work is parked
  expect(kinds.slice(2, 5).sort()).toEqual(["parked", "plan-proposal", "plan-proposal"]);
  expect(kinds[5]).toBe("verdict-ready");
  await shot(page, "needs-you-queue");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "needs-you-queue");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Authorization: a person with only the viewer role sees every item, the approval's exact digest included, but cannot decide any of them.
  const memberships = brain.store.control.prepare("SELECT rowid AS id, role FROM workspace_memberships WHERE workspace_id='ws-queue' AND principal_id=? AND revoked_at_ms IS NULL").all(actor.actorId) as Array<{ id: number; role: string }>;
  expect(memberships.length).toBeGreaterThan(0);
  brain.store.control.prepare("UPDATE workspace_memberships SET role='viewer' WHERE workspace_id='ws-queue' AND principal_id=? AND revoked_at_ms IS NULL").run(actor.actorId);
  await page.reload();
  await expandQueue();
  const approvalRow = queue.locator('[data-kind="approval"]');
  await expect(queue.getByTestId("needs-you-item")).toHaveCount(6, { timeout: 30_000 });
  await expect(approvalRow).toContainText("Publish fixture on t-queue in prod");
  await expect(approvalRow.getByText(/sha256:/).first()).toBeVisible();
  await expect(approvalRow.getByRole("button", { name: "Review action", exact: true })).toBeDisabled();
  await expect(approvalRow.getByTestId("needs-you-no-scope")).toContainText("only an approver");
  const planRow = queue.getByTestId("needs-you-item").filter({ hasText: "Plan proposal for Venue shortlist" });
  await expect(planRow.getByRole("button", { name: "Confirm this plan", exact: true })).toHaveCount(0);
  await expect(planRow.getByTestId("needs-you-no-scope")).toContainText("only an operator");
  await shot(page, "needs-you-viewer");
  for (const row of memberships) brain.store.control.prepare("UPDATE workspace_memberships SET role=? WHERE rowid=?").run(row.role, row.id);
  // Deciding approvals needs the approver role on top of leading the workspace.
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-queue', ?, ?, 'approver', 1, ?, ?)")
    .run(actor.organizationId, actor.actorId, actor.actorId, Date.now());
  await page.reload();
  await expandQueue();
  await expect(queue.getByTestId("needs-you-item")).toHaveCount(6, { timeout: 30_000 });

  // Approve inline: exact digest in the row, step-up in the dialog, the row leaves the queue without a reload.
  await expect(approvalRow.getByText(/sha256:/).first()).toBeVisible();
  await approvalRow.getByRole("button", { name: "Review action", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^Decision note/).fill("reviewed from Today");
  await page.getByLabel(/^Authenticator code/).fill(totpCode(secret, Date.now()));
  await page.getByRole("button", { name: "Verify identity and approve", exact: true }).click();
  await expect(page.getByText(/Decision recorded/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect.poll(() => (brain.store.control.prepare("SELECT state FROM approval_requests WHERE id='apr-queue-1'").get() as { state: string }).state).toBe("approved");
  await expect(queue.locator('[data-kind="approval"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(queue.getByTestId("needs-you-item")).toHaveCount(5);

  // Confirm a plan inline.
  const confirmRow = queue.getByTestId("needs-you-item").filter({ hasText: "Plan proposal for Venue shortlist" });
  await expect(confirmRow).toContainText("Venue shortlist task");
  await confirmRow.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect(confirmRow).toHaveCount(0, { timeout: 15_000 });
  expect((db.prepare("SELECT state FROM plan_versions WHERE id=?").get(confirmPlan) as { state: string }).state).toBe("confirmed");

  // Reject a plan inline, with the reason.
  const rejectRow = queue.getByTestId("needs-you-item").filter({ hasText: "Plan proposal for Vendor review" });
  await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
  await rejectRow.getByLabel("Why not this plan?").fill("Too broad for this quarter");
  await rejectRow.getByRole("button", { name: "Reject this plan", exact: true }).click();
  await expect(rejectRow).toHaveCount(0, { timeout: 15_000 });
  expect((db.prepare("SELECT state FROM plan_versions WHERE id=?").get(rejectPlan) as { state: string }).state).toBe("rejected");

  // Retry parked work inline.
  const parkedRow = queue.getByTestId("needs-you-item").filter({ hasText: "Collect the quotes is parked" });
  await expect(parkedRow).toContainText("could not reach the source");
  await parkedRow.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(parkedRow).toHaveCount(0, { timeout: 15_000 });
  expect((db.prepare("SELECT parked FROM work_items WHERE id=?").get(parkedItem.id) as { parked: number }).parked).toBe(0);

  // Sign off a verified mission inline (two steps: the close is final).
  const verdictRow = queue.getByTestId("needs-you-item").filter({ hasText: "Quarterly note is verified and ready to close" });
  await shot(page, "needs-you-before-signoff");
  await verdictRow.getByRole("button", { name: "Sign off and close", exact: true }).click();
  await verdictRow.getByRole("button", { name: "Yes, the goal is achieved", exact: true }).click();
  await expect(verdictRow).toHaveCount(0, { timeout: 15_000 });
  expect(db.prepare("SELECT state, outcome FROM missions WHERE id=?").get(verdictId)).toEqual({ state: "closed", outcome: "achieved" });
  await shot(page, "needs-you-after");

  // The bell and the queue agree: nothing blocks any more; the finished mission is a result to look at, not a decision.
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Needs you: nothing waiting" })).toBeVisible();
  expect(errors).toEqual([]);
});
