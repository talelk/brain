import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";

/**
 * Signed run receipts (#153), first-time-user walkthrough: a person starts the operations triage task from the catalog, real runners (an
 * author and an independent evaluator, each with its own enrolled key) finish it, and the run's Evidence tab says who signed the work and
 * that it verifies, with the receipt's digest. The receipt is the runner's own, signed with the key it enrolled with.
 */
test.use({ requireTwoFactor: false, integrationUrls: true });

test("the run's evidence says which runner signed it, and that the signature verifies", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const brain = governor.app.brain;
  const boot = await brain.bootstrap({ organizationId: "org-ui-receipt", name: "Receipts", email: "receipt@example.test", password: "receipt-password-123" }, governor.credential);
  const { actor } = await brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }));
  brain.createWorkspace(actor, { workspaceId: "operations", slug: "operations" });
  const starter = fixtureStarter();
  const { digest } = brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas);
  brain.activateRelease(actor, digest);

  await page.goto(governor.url);
  await page.getByLabel(/^Email/).fill("receipt@example.test");
  await page.getByLabel(/^Password/).fill("receipt-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true, level: 1 })).toBeVisible();

  const cfg = (group: string) => ({ governorUrl: governor.url, runnerId: `runner-receipt-${group}`, stateDir: join(brain.store.dataDir, `runner-${group}`), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] });
  const author = cfg("agents"), evaluator = cfg("evaluators");
  const authorSession = await enrollAndHello(author, brain.jobProtocol.issueEnrollment(actor, "agents").token);
  const evalSession = await enrollAndHello(evaluator, brain.jobProtocol.issueEnrollment(actor, "evaluators").token);

  await page.goto(`${governor.url}/w/operations/plays?mode=catalog`);
  await page.getByRole("region", { name: "Task catalog", exact: true }).getByRole("button", { name: "Start task: operations-triage", exact: true }).click();
  await page.getByLabel(/^Situation/).fill("Latency increased after deployment");
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.waitForURL(/\/runs\//);
  expect(await runOnce(author, authorSession.sessionToken, authorSession.epoch)).toBe(true);
  expect(await runOnce(evaluator, evalSession.sessionToken, evalSession.epoch)).toBe(true);
  await page.reload();
  await page.getByRole("radio", { name: "Evidence", exact: true }).click();

  const receipt = page.getByTestId("run-receipt");
  await expect(receipt).toBeVisible();
  // The author's runner signed the work, and the screen says so in plain words with the receipt's digest.
  await expect(receipt).toContainText("Signed by runner runner-receipt-agents (verified)");
  await expect(receipt).toContainText("Receipt digest");
  const stored = brain.store.control.prepare("SELECT receipt_digest FROM attempt_receipts WHERE runner_id='runner-receipt-agents'").get() as { receipt_digest: string };
  await receipt.getByText("Full value").click();
  await expect(receipt).toContainText(stored.receipt_digest);
  await expect(page.getByText("Independent verdict: verified", { exact: true })).toBeVisible();
  await expect(receipt.getByText("does not verify")).toHaveCount(0);
  await receipt.scrollIntoViewIfNeeded();
  expect(errors).toEqual([]);
});
