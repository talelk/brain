import { expect, signIn, starter, test } from "./stack";

const operator = 'description = "Restarts containers."\nengine = ["pi"]\nnative = "none"\ntools = ["deploy.restart"]\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const play = 'title = "Restart a container"\ndescription = "Restarts one container of the stack."\n[[step]]\nid = "restart"\nagent = "operator"\n'
  + 'goal = """Restart the web container.\nFIXTURE @work tool deploy.restart {"container": "web-1"}\nFIXTURE @work reply The tool answered: %last%"""\n';

test("the Overview shows what waits across several workspaces, opens a task and decides a call in place", async ({ page, stack }) => {
  const api = await stack.setUp();
  const first = await starter(api);
  await first.connectModel();
  // Two more workspaces, each with a call that waits for the person.
  const files = { "agents/operator/agent.toml": operator, "agents/operator/prompt.md": "You are the operator.\n", "tools/deploy.restart/tool.toml": restart, "tools/deploy.restart/run.sh": "#!/bin/sh\ncat\n", "plays/restart.toml": play };
  for (const name of ["Shop", "Billing"]) {
    const made = await api.command("workspace.create", { name, packs: ["base"] });
    const { content } = await api.query("file.read", { workspaceId: made.workspaceId, path: "brain.toml" });
    await api.command("file.write", { workspaceId: made.workspaceId, files: [{ path: "brain.toml", content: `${content}\n[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "http://127.0.0.1:9/v1"\nmodel = "fixture-model"\n` }, ...Object.entries(files).map(([path, content2]) => ({ path, content: content2 }))] });
    await api.command("task.create", { workspaceId: made.workspaceId, play: "restart", inputs: {} });
  }
  await signIn(page, stack);

  // One list for every workspace, each row naming its workspace and the action asked.
  const needs = page.getByRole("list", { name: "Needs you" });
  await expect(needs.getByRole("listitem")).toHaveCount(2);
  await expect(needs.getByRole("listitem").filter({ hasText: "Shop" })).toContainText("Approve a call");
  await expect(needs.getByRole("listitem").filter({ hasText: "Billing" })).toContainText("deploy.restart");
  // The sidebar counts what waits in each workspace.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Shop/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Needs you: 1")).toHaveCount(2);
  await expect(page.getByRole("row", { name: /Billing/u }).first()).toContainText("1");

  // Decide one in place: the row is open, shows exactly the call, and approving it removes it from the list.
  const shop = needs.getByRole("listitem").filter({ hasText: "Shop" });
  await expect(shop.getByText("web-1").first()).toBeVisible();
  await shop.getByRole("button", { name: "Approve this call" }).click();
  await expect(needs.getByRole("listitem")).toHaveCount(1);

  // Jump into the other one's task.
  await needs.getByRole("link", { name: /^Open Restart a container/u }).click();
  await expect(page).toHaveURL(/\/w\/billing\/tasks\//u);
  await expect(page.getByText("Approve a call").first()).toBeVisible();
});
