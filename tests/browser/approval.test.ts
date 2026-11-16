import { expect, openWorkspace, signIn, starter, test } from "./stack";

const operator = 'description = "Restarts containers."\nengine = ["pi"]\nnative = "none"\ntools = ["deploy.restart"]\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const play = 'title = "Restart a container"\ndescription = "Restarts one container of the stack."\n[[step]]\nid = "restart"\nagent = "operator"\n'
  + 'goal = """Restart the web container.\nFIXTURE @work tool deploy.restart {"container": "web-1"}\nFIXTURE @work reply The tool answered: %last%"""\n';

test.beforeEach(async ({ page, stack }) => {
  const workspace = await starter(await stack.setUp());
  await workspace.connectModel();
  await workspace.write({
    "agents/operator/agent.toml": operator, "agents/operator/prompt.md": "You are the operator.\n", "tools/deploy.restart/tool.toml": restart, "tools/deploy.restart/run.sh": "#!/bin/sh\ncat\n",
    "plays/restart.toml": play,
  });
  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.getByRole("button", { name: "Restart a container" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
});

test("a call with an effect waits on Today until a person approves exactly it, then runs", async ({ page }) => {
  await page.getByRole("link", { name: "Today" }).first().click();
  const card = page.getByRole("listitem").filter({ hasText: "operator wants to run" });
  await expect(card.getByText("Approve a call")).toBeVisible();
  await expect(card.getByText("deploy.restart", { exact: true }).first()).toBeVisible();
  await expect(card.getByText("web-1").first()).toBeVisible();
  await card.getByRole("button", { name: "Approve this call" }).click();
  await expect(card).toBeHidden();

  await page.getByRole("link", { name: /Restart a container/u }).first().click();
  await expect(page.getByText("Done, checked by checker").first()).toBeVisible();
  await expect(page.getByText('The tool answered: {"container":"web-1"}').first()).toBeVisible();
  await expect(page.getByText("deploy.restart approved by Maya Haddad")).toBeVisible();
});

test("a rejection says why, and the agent is told", async ({ page }) => {
  await page.getByRole("link", { name: "Today" }).first().click();
  const card = page.getByRole("listitem").filter({ hasText: "operator wants to run" });
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await card.getByLabel("Why you reject it").fill("Wait for the release window.");
  await card.getByRole("button", { name: "Reject this call" }).click();

  await page.getByRole("link", { name: /Restart a container/u }).first().click();
  await expect(page.getByText("Done, checked by checker").first()).toBeVisible();
  // What the agent was told is in its result: the call did not happen, and why.
  await expect(page.getByText("Wait for the release window.").first()).toBeVisible();
  await expect(page.getByText("deploy.restart rejected by Maya Haddad")).toBeVisible();
});
