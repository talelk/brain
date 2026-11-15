import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { policyDocs } from "../support/policy-world";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";

/**
 * Policy enforced while work runs (#147, ADR 0067), walked as a first-time administrator: the release's policy is in its release view
 * with the layer behind each rule, and a task the policy refuses says on its run page why, naming the layer and the rule.
 */
test("a release's policy shows in the release view, and a refused run says why on its page", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor } = await signUpOwner(page, governor, "policy");
  brain.createWorkspace(actor, { workspaceId: "ws-policy", slug: "policy" });
  const docs = policyDocs({ layers: [{ id: "no-echo", spec: { deniedOperations: ["fixture.echo"], maxRuntimeSeconds: 90 } }] });
  const release = brain.stageRelease(actor, docs, "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4").digest;
  brain.activateRelease(actor, release);
  const ws = { ...actor, workspaceId: "ws-policy", scopes: scopesForPrincipal(brain.store, actor.actorId, actor.organizationId, "ws-policy") };
  await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: "cmd-policy", commandType: "workflow.dispatch", workspaceId: "ws-policy", idempotencyKey: "policy",
    payload: { workflow: { id: "fixture-workflow", digest: release }, input: { message: "policy" } },
  } as never, "policy");
  const jobId = (brain.store.control.prepare("SELECT id FROM jobs ORDER BY created_at_ms DESC LIMIT 1").get() as { id: string }).id;

  // The administrator opens the release and looks inside it: the policy is there, each rule with the layer that set it.
  await page.goto(`${governor.url}/settings?tab=release`);
  await expect(page.getByLabel("Release", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "See what is inside", exact: true }).click();
  const policy = page.locator("[data-release-policy]");
  await expect(policy.getByRole("heading", { name: "Policy in force" })).toBeVisible();
  await expect(policy).toContainText("config/fixture-policy.yaml → config/no-echo.yaml");
  await expect(policy.locator("[data-policy-rule=denied]")).toContainText("fixture.echo");
  await expect(policy.locator("[data-policy-rule=denied]")).toContainText("set by config/no-echo.yaml");
  await expect(policy.locator("[data-policy-rule=runtime]")).toContainText("90 seconds");
  await expect(policy.locator("[data-policy-rule=runtime]")).toContainText("set by config/no-echo.yaml");
  await expect(policy.locator("[data-policy-rule=isolation]")).toContainText("ephemeral-container");
  await expect(policy.locator("[data-policy-rule=duties]")).toContainText("cannot approve it");
  await expect(policy).toHaveScreenshot("release-policy.png", { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });

  // The task the policy refused: its run page says so, why, and which layer and rule did it.
  await page.goto(`${governor.url}/runs/${jobId}`);
  await expect(page.getByText("This run was refused by policy").first()).toBeVisible();
  const why = page.locator("[data-run-policy-refusal]");
  await expect(why).toContainText("Why:");
  await expect(why).toContainText("denies the operation fixture.echo");
  await expect(why).toContainText("config/no-echo.yaml");
  await expect(why).toContainText("deniedOperations");
  await expect(page.getByText(/never started/).first()).toBeVisible();
  await expect(page.getByText("This run was stopped by policy before it started.").first()).toBeVisible();
  await expect(why).toHaveScreenshot("run-policy-refusal.png", { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  // No sideways scroll at any width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
