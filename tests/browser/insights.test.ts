import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, openWorkspace, onPhone, signIn, starter, test, type Stack } from "./stack";

const editor = 'description = "Polishes what the others wrote."\nengine = ["pi"]\nnative = "none"\ntools = []\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const step = (id: string, agent: string, after: string[], reply: string, review = false): string =>
  `[[step]]\nid = "${id}"\nagent = "${agent}"\nafter = ${JSON.stringify(after)}\n${review ? 'review_by = "checker"\n' : ""}goal = """Do ${id}.\nFIXTURE @work reply ${reply}"""\n`;
const relay = `title = "Relay"\ndescription = "Research, draft, publish."\n${step("research", "worker", [], "Facts.")}${step("draft", "editor", ["research"], "A draft.", true)}${step("publish", "worker", ["draft"], "Published.")}`;
const DAY = 86_400_000;

/** Moves everything recorded for a goal back in time, so a test has days of history to look at. */
function age(stack: Stack, rootId: string, ms: number): void {
  const { db } = stack.governor.gov;
  const tree = "(SELECT id FROM tasks WHERE root_id=?)";
  db.prepare("UPDATE tasks SET created_at_ms=created_at_ms-?, updated_at_ms=updated_at_ms-?, started_at_ms=started_at_ms-?, finished_at_ms=finished_at_ms-? WHERE root_id=?").run(ms, ms, ms, ms, rootId);
  db.prepare(`UPDATE attempts SET created_at_ms=created_at_ms-?, started_at_ms=started_at_ms-?, finished_at_ms=finished_at_ms-?, available_at_ms=available_at_ms-? WHERE task_id IN ${tree}`).run(ms, ms, ms, ms, rootId);
  db.prepare(`UPDATE tool_calls SET created_at_ms=created_at_ms-?, finished_at_ms=finished_at_ms-? WHERE task_id IN ${tree}`).run(ms, ms, rootId);
  db.prepare(`UPDATE checks SET created_at_ms=created_at_ms-? WHERE task_id IN ${tree}`).run(ms, rootId);
  db.prepare(`UPDATE usage SET created_at_ms=created_at_ms-?, settled_at_ms=settled_at_ms-? WHERE task_id IN ${tree}`).run(ms, ms, rootId);
}

async function serious(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`);
}

test("a goal's timeline selects the attempt a bar shows, and Insights counts goals by range @phone", async ({ page, stack }) => {
  test.setTimeout(150_000);
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/editor/agent.toml": editor, "agents/editor/prompt.md": "You are the editor.\n", "plays/relay.toml": relay });
  const goals: string[] = [];
  for (let index = 0; index < 3; index += 1) goals.push((await api.command("task.create", { workspaceId: workspace.id, play: "relay", inputs: {} })).taskId);
  for (const taskId of goals) await expect.poll(async () => (await api.query("task.get", { workspaceId: workspace.id, taskId })).state, { timeout: 90_000 }).toBe("done");
  // One goal today, one three days ago, one nine days ago.
  age(stack, goals[1] as string, 3 * DAY);
  age(stack, goals[2] as string, 9 * DAY);

  await signIn(page, stack);
  await openWorkspace(page, "Starter");
  await page.goto(`${stack.url}/w/starter/tasks/${goals[0]}`);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/view=timeline/u);
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline.getByRole("button", { name: /^Draft: Work, editor/u })).toBeVisible();
  await expect(timeline.getByRole("button", { name: /^Draft: Check, checker/u })).toBeVisible();
  // A click on a bar selects its task, as a node of the graph does.
  await timeline.getByRole("button", { name: /^Draft: Work, editor/u }).click();
  await expect(page).toHaveURL(/link=t_/u);
  await expect(timeline.locator('.tl-row[data-selected="true"]')).toContainText("Draft");
  await expect(page.getByTestId("timeline-readout")).toContainText("Draft: Work, editor");
  await timeline.getByLabel("Highlight the critical path").check();
  await timeline.getByRole("button", { name: "Zoom in" }).click();
  await expect(timeline.getByRole("button", { name: "Show everything" })).toBeEnabled();
  await timeline.getByText("Show the attempts as a table").click();
  await expect(timeline.getByRole("table").getByRole("row")).toHaveCount(7);
  expect(await serious(page)).toEqual([]);
  // Back on the graph, the same task stays selected.
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page).not.toHaveURL(/view=timeline/u);
  const back = page.getByRole("button", { name: "The record of this goal", exact: true });
  if (onPhone(page)) await back.click();
  await expect(page.getByRole("group", { name: "The record of this goal" }).getByRole("button", { name: /^Draft/u })).toHaveAttribute("aria-current", "true");

  // Insights: the range changes what is counted; the grids can be walked with the keys.
  await page.goto(`${stack.url}/insights`);
  await expect(page.getByRole("heading", { level: 1, name: "Insights" })).toBeVisible();
  const total = page.getByTestId("goals-total");
  await expect(total).toHaveText("3");
  await page.getByTestId("insights-range").getByRole("button", { name: "7 days" }).click();
  await expect(page).toHaveURL(/days=7/u);
  await expect(total).toHaveText("2");
  await page.getByTestId("insights-range").getByRole("button", { name: "90 days" }).click();
  await expect(total).toHaveText("3");
  const grid = page.getByRole("grid", { name: "Attempts started by weekday and hour" });
  await grid.getByRole("gridcell").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByText(/attempts? started$/u).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Where time and money go" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Agent", exact: true })).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await serious(page)).toEqual([]);
});

const operator = 'description = "Restarts containers."\nengine = ["pi"]\nnative = "none"\ntools = ["deploy.restart"]\n[limits]\nturns = 5\ntokens = 20000\nspend_usd = 0\n';
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
// Two branches at once: the call that waits for a person, and a note that is done. The note is off the critical path.
const restartPlay = 'title = "Restart and note"\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = """Restart the web container.\nFIXTURE @work tool deploy.restart {"container": "web-1"}"""\n[[step]]\nid = "note"\nagent = "worker"\ngoal = """Note it.\nFIXTURE @work reply Noted."""\n[[step]]\nid = "wrap"\nagent = "worker"\nafter = ["restart", "note"]\ngoal = "Wrap up."\n';

test("on a goal that waits for a call, the wait and the call are buttons a finger can hit, the bars stay the same elements as time passes, and what is off the critical path keeps its contrast", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.connectModel();
  await workspace.write({ "agents/operator/agent.toml": operator, "agents/operator/prompt.md": "You are the operator.\n", "tools/deploy.restart/tool.toml": restart, "tools/deploy.restart/run.sh": "#!/bin/sh\ncat\n", "plays/restart.toml": restartPlay });
  const { taskId } = await api.command("task.create", { workspaceId: workspace.id, play: "restart", inputs: {} });
  await expect.poll(async () => (await api.query("overview", {})).needsYou.length, { timeout: 60_000 }).toBe(1);
  await signIn(page, stack);
  await page.goto(`${stack.url}/w/starter/tasks/${taskId}?view=timeline`);
  const timeline = page.getByTestId("timeline");
  const wait = timeline.getByRole("button", { name: /Waiting for an approval of deploy\.restart/u });
  const call = timeline.getByRole("button", { name: /Call of deploy\.restart/u });
  for (const target of [wait, call]) {
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
    await target.focus();
    await expect(target).toBeFocused();
  }
  // The timeline moves with the clock while the goal waits, and does it in place: the same bar, not a new one.
  const bar = timeline.locator(".tl-bar").first();
  await bar.evaluate((node) => { node.setAttribute("data-mark", "kept"); });
  const before = await bar.evaluate((node) => (node as HTMLElement).style.insetInlineStart + (node as HTMLElement).style.inlineSize);
  await expect.poll(async () => bar.evaluate((node) => (node as HTMLElement).style.insetInlineStart + (node as HTMLElement).style.inlineSize), { timeout: 15_000 }).not.toBe(before);
  await expect(timeline.locator('.tl-bar[data-mark="kept"]')).toHaveCount(1);
  // Off the critical path is dimmed in colour, and every text on it still reads.
  await timeline.getByLabel("Highlight the critical path").check();
  expect(await timeline.locator('.tl-row[data-critical-row="false"] .tl-bar').count()).toBeGreaterThan(0);
  expect(await serious(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await serious(page)).toEqual([]);
});
