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

test.describe.configure({ timeout: 120_000 });

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
  // The attempt in the slot has a ring that fills over ten minutes, and a line for its tokens that waits for a second sample.
  const pill = page.getByTestId("live-run");
  const filled = async (): Promise<number> => Number.parseFloat((await pill.locator("circle.live-arc").getAttribute("stroke-dasharray")) ?? "0");
  const first = await filled();
  await expect.poll(filled, { timeout: 30_000 }).toBeGreaterThan(first + 0.1);
  // The line of tokens is drawn once the page has read two answers.
  await expect.poll(async () => (await pill.locator("path.live-spark").first().getAttribute("d", { timeout: 1000 }).catch(() => "")) ?? "", { timeout: 30_000 }).toMatch(/^M/u);
  // Every animated element has its animation, and all of them are still under reduced motion (the pulse and the glow are drawn by `::after`).
  const animated = [[".live-flow", ""], [".live-dot", ""], [".live-breathe", ""], [".live-attn", "::after"], [".live-arrive", ""], ["path.live-spark", ""]] as const;
  const names = (): Promise<string[]> => page.evaluate((list) => list.map(([selector, pseudo]) => { const node = document.querySelector(selector); return node ? getComputedStyle(node, pseudo || null).animationName : "missing"; }), animated);
  expect(await names()).toEqual(["live-flow", "live-dim", "live-dim", "live-pulse", "live-in", "live-fade"]);
  // Only transform and opacity move: no animation here changes a painted property.
  expect(await page.evaluate(() => { const painted = /stroke|box-shadow|width|height|filter|background|color/u; return [...document.getAnimations()].filter((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith("live-") && (animation.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => Object.keys(frame).some((key) => painted.test(key)))).length; })).toBe(0);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  expect(await names()).toEqual(["none", "none", "none", "none", "none", "none"]);
  expect(await serious(page), "reduced motion").toEqual([]);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // Ambient fills the screen and Escape leaves it.
  await page.getByRole("button", { name: "Ambient" }).click();
  await expect(page.getByRole("button", { name: "Leave ambient mode" })).toBeVisible();
  await expect(page.getByTestId("stage-queued")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ambient" })).toBeVisible();

  // Village is its own screen: the party names the hero at work, choosing it opens its panel, and Ambient fills the screen with the village.
  await (await sidebar(page)).getByRole("link", { name: "Village", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Village" })).toBeVisible();
  await expect(page.getByTestId("river")).toHaveCount(0);
  await expect(page.getByTestId("live-world").getByTestId("live-hero")).toContainText("operator");
  await page.getByTestId("live-hero").first().click();
  await expect(page.getByTestId("live-panel")).toContainText("Restart a container");
  await page.getByTestId("live-panel").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("live-panel")).toHaveCount(0);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
    expect(await serious(page), `village ${scheme}`).toEqual([]);
  }
  await page.getByRole("button", { name: "Ambient" }).click();
  const fill = async (): Promise<{ w: number; h: number }> => page.getByRole("region", { name: /Village map/u }).evaluate((node) => { const box = node.getBoundingClientRect(); return { w: box.width / innerWidth, h: box.height / innerHeight }; });
  expect((await fill()).w).toBeGreaterThan(0.6);
  expect((await fill()).h).toBeGreaterThan(0.6);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ambient" })).toBeVisible();
  await (await sidebar(page)).getByRole("link", { name: "Live", exact: true }).click();
  await expect(page.getByTestId("stage-queued")).toBeVisible();
  // The person approves the call while the page is open: the attempt leaves its slot in the colour of its end, the goal rings once, the flow counts it and the feed says so.
  const need = (await api.query("overview", {})).needsYou[0];
  await api.command("approval.decide", { workspaceId: workspace.id, approvalId: need?.approval?.id ?? "", decision: "approve", subjectDigest: need?.approval?.subjectDigest ?? "" });
  const leaving = page.locator('[data-testid="live-run"][data-ending]');
  await expect(leaving).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("live-celebration")).toContainText("Restart a container");
  expect(await leaving.locator("path.live-check").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("live-pop");
  await expect(page.getByTestId("stage-done")).not.toHaveAttribute("data-value", "0");
  await expect(page.getByTestId("live-feed")).toContainText("is done");
  await expect(page.getByTestId("live-attention")).toHaveCount(0);
  // Reduced motion stills the leaving pill, the check and the celebration's glow.
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  expect(await page.evaluate(() => [[".live-leave", ""], [".live-check", ""], [".live-glow", "::after"]].map(([selector, pseudo]) => { const node = document.querySelector(selector as string); return node ? getComputedStyle(node, (pseudo as string) || null).animationName : "gone"; }))).toEqual(["none", "none", "none"]);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
});

test("Live reads right to left in Arabic, and an archived workspace says there is nothing to show", async ({ page, stack }) => {
  const api = await stack.setUp();
  await starter(api);
  await signIn(page, stack);
  await page.goto(`${stack.url}/live?lang=ar`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const queued = await page.locator('[data-stage="queued"]').boundingBox();
  const failed = await page.locator('[data-stage="failed"]').boundingBox();
  expect(queued && failed && queued.x > failed.x).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // A workspace that is archived has no Live view: the screen says so instead of waiting for it.
  const old = await api.command("workspace.create", { name: "Old one", packs: [] });
  await api.command("workspace.archive", { workspaceId: old.workspaceId });
  await page.goto(`${stack.url}/w/${old.slug}/live?lang=ar`);
  await expect(page.getByText("لا شيء مباشر هنا")).toBeVisible();
  await expect(page.getByTestId("live-lane")).toHaveCount(0);
});
