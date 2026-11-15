import { test, expect } from "./fixtures";
import { seedHuman, type TestWorld } from "../helpers";
import { signUpOwner } from "../support/flow";
import { fixtureStarter } from "../support/starter";
import { achievedMission } from "../support/reuse";

// A first-time owner decides who may read what Brain learned (#135): approve a write-up for its author only, ask to share it with the
// mission team, approve that, and see the scope on the card and in search. A teammate never sees it until it is shared that widely.
test("memory scopes: keep a write-up private, share it with the mission team, then the workspace, in the real app", async ({ page, governor }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "scopes");
  brain.createWorkspace(actor, { workspaceId: "ws-scopes", slug: "scopes" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-scopes")).actor;
  const world = { brain, owner: scoped, workspaceId: "ws-scopes", org: actor.organizationId } as unknown as TestWorld;
  await achievedMission(world, "past", {
    title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes",
    criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"],
  });
  // A teammate who can read the workspace.
  seedHuman(brain, actor.organizationId, "teammate");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-scopes', ?, 'teammate', 'viewer', 1, ?, ?)").run(actor.organizationId, actor.actorId, brain.store.now());
  const teammate = (): ReturnType<TestWorld["actor"]> => ({ ...scoped, actorId: "teammate", kind: "human", scopes: ["workspace:read"] });
  const teammateSees = async (): Promise<string[]> => {
    const query = { contractVersion: "brain.memory/v1", queryId: "q-mate", scope: { organizationId: actor.organizationId, visibility: "workspace", workspaceId: "ws-scopes" }, query: "quarterly churn causes", sourceTypes: ["knowledge"], limit: 8, maxChars: 2000 };
    return ((await brain.searchMemoryAsync(teammate(), "ws-scopes", query as never)) as unknown as { snapshot: { results: Array<{ sourceId: string }> } }).snapshot.results.map((hit) => hit.sourceId);
  };

  await page.goto(`${governor.url}/w/ws-scopes/knowledge/review`);
  const card = page.locator('[data-testid^="knowledge-proposal-"]').first();
  await expect(card).toContainText("Quarterly churn report");
  // 1. The reviewer chooses who can read it before approving; the default is the whole workspace.
  const choice = card.locator("select");
  await expect(choice).toHaveValue("workspace");
  await expect(choice.locator("option")).toHaveText(["Whole workspace", "Mission team", "Only its author"]);
  await choice.selectOption("private");
  await card.getByRole("button", { name: "Approve and publish", exact: true }).click();
  await expect(card).toContainText("Readable by: Only its author");
  expect(await teammateSees()).toEqual([]);

  // 2. The author asks for a wider scope; asking alone changes nothing for anyone else.
  await card.getByRole("button", { name: "Ask to share with mission team" }).click();
  await expect(card).toContainText("Asked to share with: Mission team");
  await expect(card).toContainText("Readable by: Only its author");
  expect(await teammateSees()).toEqual([]);

  // 3. A review grants exactly what was asked for (the only reviewer here may review their own: it says so).
  await card.getByRole("button", { name: "Approve sharing with mission team" }).click();
  await expect(card).toContainText("Readable by: Mission team");
  await expect(card).toContainText("Self-reviewed");
  await expect(card).not.toContainText("Asked to share with");
  expect(await teammateSees()).toEqual([]);

  // 4. Search shows the scope on the hit for the author.
  await page.goto(`${governor.url}/w/ws-scopes/knowledge`);
  await page.getByLabel("Search scoped knowledge").fill("quarterly churn causes");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Approved knowledge", { exact: true })).toBeVisible();
  await expect(page.getByText("Mission team", { exact: true }).first()).toBeVisible();

  // 5. The workspace is the widest ask; once granted the teammate reads it, and narrowing takes it away at once.
  await page.goto(`${governor.url}/w/ws-scopes/knowledge/review`);
  await card.getByRole("button", { name: "Ask to share with whole workspace" }).click();
  await card.getByRole("button", { name: "Approve sharing with whole workspace" }).click();
  await expect(card).toContainText("Readable by: Whole workspace");
  expect((await teammateSees()).length).toBe(1);
  await card.getByRole("button", { name: "Limit to mission team" }).click();
  await expect(card).toContainText("Readable by: Mission team");
  expect(await teammateSees()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
