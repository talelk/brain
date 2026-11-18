import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, sidebar, signIn, starter, test } from "./stack";

// Two tasks that wait for a capability no runner has (queued), and a call that waits for the person (needs you).
const needy = 'description = "Needs docker."\nengine = ["pi"]\nnative = "none"\ntools = ["docker.ps"]\n';
const docker = 'description = "Lists containers."\neffect = "read"\nneeds = ["docker"]\n';
const job = 'title = "Job"\n[[step]]\nid = "run"\nagent = "needy"\ngoal = "Run the job."\n';
const operator = 'description = "Restarts containers."\nengine = ["pi"]\nnative = "none"\ntools = ["deploy.restart"]\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const restartPlay = 'title = "Restart a container"\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = """Restart the web container.\nFIXTURE @work tool deploy.restart {"container": "web-1"}"""\n';

const serious = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`);

test("Live shows the runner's lane, the numbers of the flow, what just happened and what needs you, and is accessible in both themes and with reduced motion @phone", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({
    "agents/needy/agent.toml": needy, "agents/needy/prompt.md": "You are needy.\n", "tools/docker.ps/tool.toml": docker, "tools/docker.ps/run.sh": "echo ok\n", "tools/docker.ps/test.sh": "echo ok\n", "plays/job.toml": job,
    "agents/operator/agent.toml": operator, "agents/operator/prompt.md": "You are the operator.\n", "tools/deploy.restart/tool.toml": restart, "tools/deploy.restart/run.sh": "#!/bin/sh\ncat\n", "plays/restart.toml": restartPlay,
  });
  for (const title of ["First job", "Second job"]) await api.command("task.create", { workspaceId: workspace.id, play: "job", title });
  await api.command("task.create", { workspaceId: workspace.id, play: "restart", inputs: {} });

  await signIn(page, stack);
  await (await sidebar(page)).getByRole("link", { name: "Live", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Live" })).toBeVisible();

  // The runner is a lane with its slots; the operator's attempt holds one while its call waits for approval.
  const lane = page.getByTestId("live-lane");
  await expect(lane).toContainText("browser runner");
  await expect(lane.getByTestId("live-slots")).toHaveText("1 of 2 slots in use");
  await expect(lane.getByTestId("live-run")).toHaveCount(1);
  await expect(lane.getByTestId("live-run")).toContainText("Restart a container");
  await expect(lane.getByTestId("live-run")).toContainText("operator");
  // The numbers of the flow: two queued, one running, one that needs the person.
  await expect(page.getByTestId("stage-queued")).toHaveAttribute("data-value", "2");
  await expect(page.getByTestId("stage-running")).toHaveAttribute("data-value", "1");
  await expect(page.getByTestId("stage-needs")).toHaveAttribute("data-value", "1");
  await expect(page.getByTestId("stage-done")).toHaveAttribute("data-value", "0");
  // The feed says what happened, and the attention bar names what waits.
  await expect(page.getByTestId("live-feed")).toContainText("waits for a call to be approved");
  await expect(page.getByTestId("live-attention")).toContainText("Restart a container");
  // A workspace tile opens into its details.
  const tile = page.getByTestId("live-tile");
  await tile.getByRole("button").click();
  await expect(tile.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(tile).toContainText("Today:");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.waitForTimeout(700);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
    expect(await serious(page), `${scheme}`).toEqual([]);
  }
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".live-flow") as Element).animationName)).toBe("live-flow");
  // With reduced motion the ribbons and pulses stand still.
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  expect(await page.evaluate(() => [".live-flow", ".live-dot"].map((selector) => { const node = document.querySelector(selector); return node ? getComputedStyle(node).animationName : "none"; }))).toEqual(["none", "none"]);
  expect(await serious(page), "reduced motion").toEqual([]);

  // Ambient fills the screen and Escape leaves it.
  await page.getByRole("button", { name: "Ambient" }).click();
  await expect(page.getByRole("button", { name: "Leave ambient mode" })).toBeVisible();
  await expect(page.getByTestId("stage-queued")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ambient" })).toBeVisible();
});
