import AxeBuilder from "@axe-core/playwright";
import { expect, openWorkspace, signIn, starter, test } from "./stack";

// An agent whose tool needs a capability the runner does not have: its tasks wait in the queue, and the queue says why.
const needy = 'description = "Needs docker."\nengine = ["pi"]\nnative = "none"\ntools = ["docker.ps"]\n';
const tool = 'description = "Lists containers."\neffect = "read"\nneeds = ["docker"]\n';
const play = 'title = "Job"\n[[step]]\nid = "run"\nagent = "needy"\ngoal = "Run the job."\n';

test("the queue shows the runner's slots, the waiting tasks in order with the reason each waits, and Run next moves one to the front @phone", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.write({ "agents/needy/agent.toml": needy, "agents/needy/prompt.md": "You are needy.\n", "tools/docker.ps/tool.toml": tool, "tools/docker.ps/run.sh": "echo ok\n", "tools/docker.ps/test.sh": "echo ok\n", "plays/job.toml": play });
  for (const title of ["First job", "Second job", "Third job"]) await api.command("task.create", { workspaceId: workspace.id, play: "job", title });

  await signIn(page, stack);
  await expect(page.getByTestId("queue-chip")).toContainText("0 running, 3 waiting");
  await openWorkspace(page, "Starter");
  await expect(page.getByTestId("queue-chip")).toContainText("3 waiting");
  await page.getByTestId("queue-chip").click();
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
  await expect(page.getByText("0 of 2 slots in use")).toBeVisible();
  const rows = page.getByTestId("queue-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("First job");
  await expect(rows.nth(0).getByTestId("queue-wait")).toContainText("No runner has the capability docker.");

  await rows.nth(2).getByRole("button", { name: "Run next" }).click();
  await expect(rows.nth(0)).toContainText("Third job");
  await expect(rows.nth(0)).toContainText("High");
  await expect(rows.nth(1)).toContainText("First job");

  await rows.nth(1).getByRole("button", { name: "Pause" }).click();
  await expect(rows.last()).toContainText("Paused: it does not start until it is resumed.");

  const serious = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious.map((violation) => violation.id)).toEqual([]);

  // The task's own page says the same, with the way to the queue.
  await rows.nth(0).getByRole("link", { name: "Third job" }).click();
  await expect(page.getByTestId("queued-notice")).toContainText("No runner has the capability docker.");
});
