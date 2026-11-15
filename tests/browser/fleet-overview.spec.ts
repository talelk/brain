import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello } from "../../apps/runner/src/supervisor";

/**
 * The fleet overview on Today (spec #90, stories 43 and 44), walked as a first-time person who is not an administrator: a viewer who
 * accepted an invitation, signed in and landed on Today. The overview names open missions by condition, the team member at work, the
 * runners' slots and spend today, and shows no runner. The owner, who may administer runners, gets the way to their detail.
 */
const DIGEST = `sha256:${"a".repeat(64)}`;

test("a member who is not an administrator sees the fleet overview without runner detail; the owner can open the runners", async ({ page, governor, browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const brain = governor.app.brain;

  // The owner signs up through the real form; a workspace, the starter release and one runner follow.
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Fleet organization");
  await page.getByLabel(/^Email/).fill("owner@example.test");
  await page.getByLabel(/^Password/).fill("owner-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const admin = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(admin, { workspaceId: "ws-fleet", slug: "fleet" });
  const bundle = fixtureStarter();
  brain.activateRelease(admin, brain.stageRelease(admin, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const owner = (await brain.resolveActor(new Headers({ cookie }), "ws-fleet")).actor;
  const cfg = { governorUrl: governor.url, runnerId: "fleet-runner-agents", stateDir: join(brain.store.dataDir, "fleet-runner"), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
  const hello = await enrollAndHello(cfg, brain.jobProtocol.issueEnrollment(admin, "agents").token);
  const runner = { runnerId: cfg.runnerId, epoch: hello.epoch, organizationId: admin.organizationId };

  const command = async (type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, workspaceId: "ws-fleet", idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key)).receipt;
  const version = async (id: string) => ((await brain.executeQuery(owner, { queryType: "missions.get", workspaceId: "ws-fleet", resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
  const mission = async (key: string, title: string, confirm: boolean) => {
    const id = (await command("mission.create", `${key}-create`, { title, intent: title, successCriteria: ["Done"] })).resourceId ?? "";
    const planId = (await command("plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [{ id: "a", title: `${title} task`, criteria: ["Done"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId ?? "";
    if (confirm) await command("plan.confirm", `${key}-confirm`, { planVersionId: planId }, await version(id));
    return id;
  };

  // One mission has a task running, one is queued behind it, one waits for the owner's OK of its plan.
  await mission("run", "Reconcile the ledger", true);
  const offer = brain.jobProtocol.claim(runner, "fleet-claim") as unknown as { attemptId: string; leaseId: string; jobFence: number };
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST, features: ["sessions"] } });
  await mission("queued", "Draft the onboarding guide", true);
  const proposal = await mission("plan", "Audit the access list", false);

  // A person is invited through the real form, creates the account, verifies the email and accepts.
  await page.goto(`${governor.url}/settings?tab=people`);
  await page.getByRole("button", { name: "Invite person", exact: true }).click();
  await page.getByRole("textbox", { name: /^Email/ }).fill("member@example.test");
  await page.getByLabel(/^Reason/).fill("Reads the fleet overview");
  await page.getByRole("button", { name: "Send invitation", exact: true }).click();
  const invitation = brain.store.control.prepare("SELECT url FROM auth_email_outbox WHERE kind='organization-invitation' AND email=?").get("member@example.test") as { url: string };
  const memberContext = await browser.newContext({ ...(page.viewportSize() ? { viewport: page.viewportSize()! } : {}), colorScheme: "light" });
  await memberContext.addInitScript(() => { try { window.localStorage.setItem("brain.locale", "en"); } catch { /* storage blocked */ } });
  const member = await memberContext.newPage();
  member.on("pageerror", (error) => errors.push(error.message));
  await member.goto(invitation.url);
  await member.getByRole("button", { name: "New to Brain? Create the invited account", exact: true }).click({ timeout: 5000 });
  await member.getByRole("textbox", { name: /^Your name/ }).fill("Fleet Member");
  await member.getByRole("textbox", { name: /^Email/ }).fill("member@example.test");
  await member.getByRole("textbox", { name: /^Password/ }).fill("member-password-1234");
  await member.getByRole("button", { name: "Create account and send verification", exact: true }).click();
  await expect(member.getByRole("heading", { name: "Verify your email", exact: true })).toBeVisible();
  const verification = brain.store.control.prepare("SELECT url FROM auth_email_outbox WHERE kind='verify-email' AND email=? ORDER BY created_at_ms DESC LIMIT 1").get("member@example.test") as { url: string };
  await member.goto(verification.url);
  await member.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(member.getByRole("heading", { name: "Invitation accepted", exact: true })).toBeVisible();
  const principalId = (brain.store.control.prepare("SELECT id FROM user WHERE email=?").get("member@example.test") as { id: string }).id;
  const workspaceVersion = ((await brain.executeQuery(owner, { queryType: "workspace.context", workspaceId: "ws-fleet" })) as unknown as { snapshot: { workspace: { version: number } } }).snapshot.workspace.version;
  await command("member.grant", "grant-member", { principalId, role: "viewer", reason: "Reads the fleet overview" }, workspaceVersion);

  // The member lands on Today.
  await member.goto(governor.url);
  // Creating the account already signed this person in; a sign-in form appears only when it did not.
  const email = member.getByLabel(/^Email/);
  if (await email.isVisible({ timeout: 3000 }).catch(() => false)) {
    await email.fill("member@example.test");
    await member.getByLabel(/^Password/).fill("member-password-1234");
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(member.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();
  const fleet = member.getByTestId("fleet-overview");
  await expect(fleet.getByRole("heading", { name: "Fleet overview", level: 2 })).toBeVisible();
  await fleet.scrollIntoViewIfNeeded();
  await expect(fleet.getByText("3 open missions")).toBeVisible();
  await expect(member.getByTestId("fleet-needs-attention")).toHaveText(/1\s*Needs attention/);
  await expect(member.getByTestId("fleet-working")).toHaveText(/1\s*Working/);
  await expect(member.getByTestId("fleet-waiting")).toHaveText(/1\s*Waiting/);
  await expect(member.getByTestId("fleet-members-count")).toHaveText("1 team member at work");
  await expect(member.getByTestId("fleet-slots")).toHaveText(/^1 of 1 slots in use$/);
  await expect(member.getByTestId("fleet-runners-online")).toHaveText("1 of 1 runner online");
  await expect(member.getByTestId("fleet-spend-today")).toHaveText(/^\$|^<\$/);
  // The strip beside it counts the same running mission.
  await expect(member.getByTestId("working-now-count")).toContainText("1 mission running");
  // Runner internals stay with administrators: the member sees capacity, never which runner or a way into runner detail.
  await expect(fleet.getByRole("button", { name: "Runner details" })).toHaveCount(0);
  await expect(member.getByText("fleet-runner-agents")).toHaveCount(0);

  // The waiting mission that needs attention opens from the overview.
  await fleet.getByRole("button", { name: /Open mission Audit the access list/ }).click();
  await expect(member).toHaveURL(new RegExp(`/missions/${proposal}`));
  await expect(member.getByRole("heading", { name: "Audit the access list" }).first()).toBeVisible();
  await member.goBack();
  await expect(fleet).toBeVisible();

  // The overview follows the work without a reload: a second plan waiting for a person moves the count.
  await mission("plan2", "Review the vendor contract", false);
  await expect(member.getByTestId("fleet-needs-attention")).toHaveText(/2\s*Needs attention/, { timeout: 25_000 });
  await expect(fleet.getByText("4 open missions")).toBeVisible();

  // The owner sees the same counts, and may open the runners.
  await page.goto(`${governor.url}/w/ws-fleet/today`);
  const ownerFleet = page.getByTestId("fleet-overview");
  await expect(ownerFleet.getByText("4 open missions")).toBeVisible();
  await ownerFleet.getByRole("button", { name: "Runner details" }).click();
  await expect(page.getByRole("heading", { name: "Runners", exact: true, level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
  await memberContext.close();
});
