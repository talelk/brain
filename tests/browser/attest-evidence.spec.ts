import { test, expect } from "./fixtures";
import type { ActorContext, VerificationVerdict } from "@brain/contracts";
import { seedHuman, goldenDocs } from "../helpers";
import { enrollRunners, signUpOwner } from "../support/flow";
import { bundleForAttempt } from "../support/evidence";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * Issue #157: an evaluation that needs a person as its independent evaluator (independence L3). A teammate starts three runs of the golden
 * fixture workflow whose eval step is raised to level 3; the first-time user, who did not start them, finds each waiting in Needs you, reviews
 * the submitted evidence on the attestation page and records a verdict as the evaluator: verified for one, rejected for another. A run the
 * user started themselves shows them why they cannot judge it, instead of a form that would be refused.
 */
const SHOT = { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" } as const;

/** Sign-up gives the person a random id whose proportional-font width changes how a line wraps; a baseline needs the same text every run. */
async function steadyIds(page: import("@playwright/test").Page, ids: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const id of list) if (node.nodeValue?.includes(id)) node.nodeValue = node.nodeValue.split(id).join("a".repeat(id.length));
  }, ids);
}

test("a person attests evidence as the independent evaluator: verified, rejected, and refused for their own work (#157)", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { brain, actor, cookie } = await signUpOwner(page, governor, "attest");
  brain.createWorkspace(actor, { workspaceId: "ws-attest", slug: "attest" });
  const docs = goldenDocs().map((doc) => doc.path.endsWith("fixture-workflow.yaml") ? { ...doc, text: doc.text.replace("      independence: L2", "      independence: L3") } : doc);
  const release = brain.stageRelease(actor, docs, "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4");
  brain.activateRelease(actor, release.digest);
  const owner: ActorContext = (await brain.resolveActor(new Headers({ cookie }), "ws-attest")).actor;
  // The teammate who starts the work.
  seedHuman(brain, actor.organizationId, "casey");
  brain.store.control.prepare('UPDATE "user" SET name=? WHERE id=?').run("Casey Ng", "casey");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES ('ws-attest',?,?,'operator',1,?,?)").run(actor.organizationId, "casey", actor.actorId, brain.store.now());
  const casey: ActorContext = { kind: "human", actorId: "casey", organizationId: actor.organizationId, workspaceId: "ws-attest", scopes: scopesForPrincipal(brain.store, "casey", actor.organizationId, "ws-attest"), authMethod: "session", authGeneration: 1 };
  const [tools] = await enrollRunners(governor, actor, "attest", ["fixture-tools"]);
  const runner = { runnerId: tools!.cfg.runnerId, epoch: tools!.epoch, organizationId: actor.organizationId };

  /** One run of the fixture workflow, started by `by`, whose author finished and submitted its evidence: the eval step now waits for a person. */
  const submitted = async (by: ActorContext, key: string): Promise<{ runId: string; digest: string }> => {
    const { receipt } = await brain.executeCommand(by, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: "ws-attest", idempotencyKey: key,
      payload: { workflow: { id: "fixture-workflow", digest: release.digest }, input: { message: "Brain fixture" } } } as never, key);
    expect(receipt.accepted).toBe(true);
    const offer = brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as { attemptId: string; leaseId: string; jobFence: number };
    brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    brain.jobProtocol.complete(runner, offer.attemptId, { result: "succeeded", output: { message: "Brain fixture", bytes: 13 }, jobFence: offer.jobFence, cleanupConfirmed: true });
    const bundle = bundleForAttempt(brain, actor.organizationId, "ws-attest", offer.attemptId, `bundle-${key}`);
    const { digest } = brain.submitEvidence(runner, bundle) as { digest: string };
    return { runId: bundle.workflowRunId, digest };
  };
  const first = await submitted(casey, "first");
  const second = await submitted(casey, "second");
  const mine = await submitted(owner, "mine");
  const ws = brain.store.workspaceDb("ws-attest", actor.organizationId);
  const verdictOf = (digest: string) => ws.prepare("SELECT outcome, manifest_json FROM verification_verdicts WHERE bundle_digest=?").get(digest) as { outcome: string; manifest_json: string } | undefined;
  const runState = (runId: string) => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;
  expect([first, second, mine].map((entry) => runState(entry.runId))).toEqual(["suspended", "suspended", "suspended"]);

  // Needs you lists all three, each as evidence to attest.
  await page.goto(`${governor.url}/w/ws-attest/today`);
  const rows = page.getByTestId("needs-you").locator('[data-kind="attestation"]');
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.first()).toContainText("Attest the evidence for fixture-workflow");
  await expect(rows.first().getByRole("button", { name: "Review", exact: true })).toBeVisible();

  // Open the first one from Needs you: the evidence is on the page and the verdict form asks for every check.
  const attestationFor = (runId: string) => (ws.prepare("SELECT id FROM evaluation_attestations WHERE run_id=?").get(runId) as { id: string }).id;
  await page.goto(`${governor.url}/attestations/${attestationFor(first.runId)}?w=ws-attest`);
  await expect(page.getByRole("heading", { name: "Attest the evidence for fixture-workflow" })).toBeVisible({ timeout: 30_000 });
  const facts = page.getByTestId("attestation-facts");
  await expect(facts).toContainText("Independence level 3: a person");
  await expect(page.getByTestId("attestation-form")).toBeVisible();
  const submit = page.getByRole("button", { name: /^Answer every check first$|^Record:/ });
  await expect(submit).toBeDisabled();
  await expect(page.getByText("Pending verification")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveScreenshot("attest-form.png", SHOT);

  // Answer each check; the button names the verdict the answers add up to, by the verdict's own rules.
  const check = (id: string) => page.getByTestId(`attest-check-${id}`);
  await check("echo-message").getByLabel("Passed", { exact: true }).check();
  await expect(submit).toBeDisabled();
  await check("echo-bytes").getByLabel("Failed", { exact: true }).check();
  await expect(page.getByTestId("attest-outcome")).toHaveAttribute("data-outcome", "rejected");
  await expect(page.getByRole("button", { name: "Record: rejected", exact: true })).toBeEnabled();
  await check("echo-bytes").getByLabel("Passed", { exact: true }).check();
  await expect(page.getByTestId("attest-outcome")).toHaveAttribute("data-outcome", "verified");
  await check("echo-message").getByRole("textbox", { name: /What you saw/ }).fill("The message matches the brief word for word");
  await expect(page).toHaveScreenshot("attest-answered.png", SHOT);
  await page.getByRole("button", { name: "Record: verified", exact: true }).click();

  // The verdict is recorded as the person's, at level 3, and the form is gone.
  await expect(page.getByText(/Evaluated by .*: verified/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("attestation-form")).toHaveCount(0);
  await expect(page.getByText(/Independent human verdict: verified/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Attested by .* independence L3 \(a person\)/)).toBeVisible();
  await steadyIds(page, [actor.actorId]);
  await expect(page).toHaveScreenshot("attest-recorded.png", SHOT);
  const verdict = JSON.parse(verdictOf(first.digest)!.manifest_json) as VerificationVerdict;
  expect(verdict).toMatchObject({ independence: "L3", outcome: "verified", acceptedBy: actor.actorId });
  expect(runState(first.runId)).toBe("succeeded");

  // Reject the second from its own page: the run ends and the work goes back.
  await page.goto(`${governor.url}/attestations/${attestationFor(second.runId)}?w=ws-attest`);
  await expect(page.getByTestId("attestation-form")).toBeVisible({ timeout: 30_000 });
  await check("echo-message").getByLabel("Failed", { exact: true }).check();
  await check("echo-message").getByRole("textbox", { name: /What you saw/ }).fill("This is not the message the brief asked for");
  await check("echo-bytes").getByLabel("Passed", { exact: true }).check();
  await page.getByRole("button", { name: "Record: rejected", exact: true }).click();
  await expect(page.getByText(/Evaluated by .*: rejected/)).toBeVisible({ timeout: 20_000 });
  expect(verdictOf(second.digest)?.outcome).toBe("rejected");
  expect(runState(second.runId)).toBe("failed");

  // Work the user started cannot be judged by them: the page says so and offers no form.
  await page.goto(`${governor.url}/attestations/${attestationFor(mine.runId)}?w=ws-attest`);
  await expect(page.getByText("You cannot attest this one")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("You started or own this work, so you cannot be its independent evaluator.")).toBeVisible();
  await expect(page.getByTestId("attestation-form")).toHaveCount(0);
  await expect(page).toHaveScreenshot("attest-blocked.png", SHOT);
  expect(verdictOf(mine.digest)).toBeUndefined();

  // Needs you now holds only the one the user cannot answer; the answered ones are gone.
  await page.goto(`${governor.url}/w/ws-attest/today`);
  await expect(page.getByTestId("needs-you").locator('[data-kind="attestation"]')).toHaveCount(1, { timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
