import { test, expect } from "./fixtures";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { seedAgentActivity } from "../support/agent-activity";

/**
 * A first-time user finds what each agent is doing and how it has done (#113): from the Library to the Agents list, to an agent's page with
 * its status (worked out from its sessions, never stored), recent runs, verified rate, failure classes and cost, each beside its definition;
 * from the mission's Team tab to a member's panel with its sessions, tasks and spend; and from the Live console and the run page back to
 * the same pages. A runner took two tasks: the writer's attempt failed, the reviewer's is still working.
 */
test("agent page and team-member panel: status, runs, verified rate, failure classes and cost, reachable from where agents are seen (#113)", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "agents");
  brain.createWorkspace(actor, { workspaceId: "ws-agents", slug: "agents" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const ws = (await brain.resolveActor(new Headers({ cookie }), "ws-agents")).actor;
  const tables = () => brain.store.workspaceDb("ws-agents", ws.organizationId).prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const tablesBefore = tables();
  const noSidewaysScroll = async (where: string) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `no sideways scroll on ${where}`).toBe(true);

  // Before anything ran, the Agents list shows every definition as idle and the page says so.
  await page.goto(`${governor.url}/w/ws-agents/library`);
  await page.getByRole("radio", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/ws-agents\/library\/agents$/);
  const writerRow = page.locator("[data-testid=agent-row][data-agent=task-worker]");
  await expect(writerRow).toContainText("Idle");

  const { missionId } = await seedAgentActivity(brain, ws, "ws-agents", "ap");

  // The list and the page work status out from the sessions now: the writer's agent failed its attempt, the reviewer's is working.
  await page.reload();
  await expect(writerRow.getByTestId("activity-status")).toHaveAttribute("data-status", "failing");
  await expect(page.locator("[data-testid=agent-row][data-agent=operations-assistant]").getByTestId("activity-status")).toHaveAttribute("data-status", "working");
  await writerRow.click();
  await expect(page).toHaveURL(/\/library\/agents\/task-worker$/);
  await expect(page.getByTestId("agent-purpose")).not.toBeEmpty();
  await expect(page.getByTestId("agent-caps")).toContainText("turns");
  await expect(page.getByTestId("activity-status")).toHaveAttribute("data-status", "failing");
  await expect(page.getByTestId("activity-reason")).toContainText("latest ended session failed");
  await expect(page.getByTestId("activity-status-definition")).toContainText("never stored");
  // Each figure carries the words that define it.
  await expect(page.getByTestId("figure-verified-value")).toContainText("0% (0 of 1)");
  await expect(page.getByTestId("figure-verified-definition")).toContainText("independent check");
  await expect(page.getByTestId("figure-sessions-value")).toContainText("0 running, 1 in all");
  await expect(page.getByTestId("figure-cost-value")).toContainText("tokens");
  await expect(page.getByTestId("figure-cost-definition")).toContainText("ledger");
  await expect(page.getByTestId("failure-class")).toHaveCount(1);
  await expect(page.getByTestId("failure-classes")).toContainText("Each run counts once");
  const run = page.getByTestId("recent-run");
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("Write the draft");
  await expect(run).toContainText("Failed");
  await noSidewaysScroll("the agent page");

  // The run opens its inspector, which names the agent and the member; both link back.
  await run.getByTestId("recent-run-open").click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId("run-agent-link").first()).toBeVisible();
  await page.getByTestId("run-agent-link").first().click();
  await expect(page).toHaveURL(/\/library\/agents\/task-worker$/);

  // From the run's member link to the member's panel on the mission's Team tab.
  await page.goBack();
  await page.getByTestId("run-member-link").first().click();
  await expect(page).toHaveURL(/\/missions\/.*\/team\?.*member=writer/);
  const panel = page.getByTestId("member-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("activity-status")).toHaveAttribute("data-status", "failing");
  await expect(panel.getByTestId("member-task")).toContainText("Write the draft");
  await expect(panel.getByTestId("figure-cost-value")).toContainText("tokens");
  await expect(panel.getByTestId("figure-cost-definition")).toContainText("in this mission");
  await expect(panel.getByTestId("failure-class")).toHaveCount(1);
  await noSidewaysScroll("the member panel");

  // The reviewer, chosen from the table, is working and its verified result counts.
  await page.getByTestId("member-open").filter({ hasText: "reviewer" }).click();
  await expect(panel).toHaveAttribute("data-member", "reviewer");
  await expect(panel.getByTestId("activity-status")).toHaveAttribute("data-status", "working");
  await expect(panel.getByTestId("figure-verified-value")).toContainText("100% (1 of 1)");
  await expect(panel.getByTestId("figure-sessions-value")).toContainText("1 running, 1 in all");
  await panel.getByTestId("member-agent-link").click();
  await expect(page).toHaveURL(/\/library\/agents\/operations-assistant$/);
  await expect(page.getByTestId("activity-status")).toHaveAttribute("data-status", "working");

  // From the Live tab: following a member offers its panel; the console names the agent as a link.
  await page.goto(`${governor.url}/missions/${missionId}/live?w=ws-agents&member=reviewer`);
  await page.getByTestId("live-member-panel").click();
  await expect(page.getByTestId("member-panel")).toHaveAttribute("data-member", "reviewer");
  await page.getByTestId("member-panel-close").click();
  await expect(page.getByTestId("member-panel")).toHaveCount(0);
  await page.getByTestId("team-agent-link").first().click();
  await expect(page).toHaveURL(/\/library\/agents\//);

  // Reading every one of these wrote no status anywhere.
  expect(tables()).toEqual(tablesBefore);
  expect(errors).toEqual([]);
});
