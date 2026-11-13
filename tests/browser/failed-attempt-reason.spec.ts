import { test, expect } from "./fixtures";
import { goldenDocs } from "../helpers";
import { signUpOwner } from "../support/flow";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * A failed attempt says why where a person looks (backlog row 99): the run inspector names what failed and the one next step, shows the
 * attempt's own words with secrets hidden, and "View logs" opens records of that attempt including an error record with the reason.
 */
const IMAGE = "Unable to find image 'brain-sandbox-evaluator:latest' locally";
const SECRET = "sk-ant-0123456789abcdefghijkl";

test("a failed run names what failed, the next step and the reason, and View logs shows the error", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor } = await signUpOwner(page, governor, "whyfail");
  brain.createWorkspace(actor, { workspaceId: "ws-why", slug: "why" });
  const release = brain.stageRelease(actor, goldenDocs(), "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4").digest;
  brain.activateRelease(actor, release);
  const ws = { ...actor, workspaceId: "ws-why", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-why") };
  await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: "cmd-why", commandType: "workflow.dispatch", workspaceId: "ws-why", idempotencyKey: "why",
    payload: { workflow: { id: "fixture-workflow", digest: release }, input: { message: "why" } },
  } as never, "why");
  const s = brain.store;
  const now = s.now();
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES ('runner-why', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(actor.organizationId, release, now);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-why', ?, 1, 'test', ?, ?)").run(cap, now, now + 3_600_000);
  }
  const runner = { runnerId: "runner-why", epoch: 1, organizationId: actor.organizationId };
  const offer = brain.jobProtocol.claim(runner, "req-why") as unknown as { jobId: string; attemptId: string; leaseId: string; jobFence: number };
  brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { error: `sandboxed execution failed: sandbox create failed 503: docker run failed: ${IMAGE} ANTHROPIC_API_KEY=${SECRET}` } });

  await page.goto(`${governor.url}/runs/${offer.jobId}`);
  await expect(page.getByText("This run did not work").first()).toBeVisible();
  await expect(page.getByText(/container image this step runs in is not installed/).first()).toBeVisible();
  await expect(page.getByText(/build-sandbox-images/).first()).toBeVisible();
  const reason = page.locator("[data-run-failure-reason]");
  await expect(reason).toContainText(IMAGE);
  await expect(reason).not.toContainText(SECRET);
  await expect(page.locator("body")).not.toContainText(SECRET);
  // No sideways scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // The link scopes to the attempt that exists and shows an error record carrying the reason.
  await page.getByRole("link", { name: "View logs" }).first().click();
  await expect(page).toHaveURL(new RegExp(`attempt=${offer.attemptId}`));
  const failed = page.getByText(/had an attempt fail/).first();
  await expect(failed).toBeVisible();
  await expect(page.getByText(new RegExp(IMAGE.slice(0, 30))).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SECRET);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
