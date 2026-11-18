import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, openWorkspace, signIn, starter, test, type Stack } from "./stack";

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
  if (await back.isVisible()) await back.click();
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
