import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";

/**
 * Standing teams in the Library (#130), as a first-time user meets them: Library has a Teams place that starts empty and says what a team is,
 * a person creates one by choosing roles, agents and engines, uses it from a plan's editor ("Use a standing team") and when starting a Play,
 * and learns that members are copied: editing or archiving the team later changes no confirmed plan. Every step goes through the screen;
 * the plan proposal row and database reads are the only direct touches.
 */
test("standing teams: create in the Library, use in a plan and a Play start, edits and archive never change what was copied", async ({ page, governor }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const brain = governor.app.brain;
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Teams organization");
  await page.getByLabel(/^Email/).fill("teams@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const actor = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(actor, { workspaceId: "ws-teams", slug: "teams" });
  const bundle = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const scoped = (await brain.resolveActor(new Headers({ cookie }), "ws-teams")).actor;
  const ws = brain.store.workspaceDb("ws-teams", actor.organizationId);
  const team = (name: string) => ws.prepare("SELECT * FROM standing_teams WHERE name=?").get(name) as { id: string; members_json: string; coordinator_member_id: string | null; state: string; version: number } | undefined;

  // The Library lists Teams as a place of its own, and it begins empty with a plain explanation.
  await page.goto(`${governor.url}/w/ws-teams/library`);
  await expect(page.getByTestId("library-shelf-teams")).toContainText("Teams");
  await expect(page.getByTestId("library-count-teams")).toHaveText("0");
  await page.getByTestId("library-shelf-teams").click();
  await expect(page).toHaveURL(/\/w\/ws-teams\/library\/teams$/);
  await expect(page.getByRole("heading", { name: "Teams", level: 1 })).toBeVisible();
  await expect(page.getByText("No standing teams yet")).toBeVisible();
  await expect(page.getByTestId("teams-copy-note")).toContainText("copies its members into the plan");

  // Create a team: two roles bound to agents, a coordinator chosen from them.
  await page.getByRole("button", { name: "New team", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel(/^Name/).fill("Research desk");
  await sheet.getByLabel("Description (optional)", { exact: true }).fill("Reads sources, then checks the write-up");
  const members = sheet.getByTestId("plan-team");
  await members.getByLabel("Role", { exact: true }).fill("Analyst");
  await members.getByLabel("Agent", { exact: true }).click();
  await page.getByRole("option", { name: /Task worker/ }).click();
  await members.getByRole("button", { name: "Add to team", exact: true }).click();
  await members.getByLabel("Role", { exact: true }).fill("Checker");
  await members.getByLabel("Agent", { exact: true }).click();
  await page.getByRole("option", { name: /Support analyst/ }).click();
  await members.getByRole("button", { name: "Add to team", exact: true }).click();
  await expect(members.getByTestId("plan-team-member")).toHaveCount(2);
  // A standing team is where members are copied from: its own form offers no "use a standing team".
  await expect(sheet.getByTestId("plan-standing-team")).toHaveCount(0);
  await sheet.getByLabel("Coordinator", { exact: true }).click();
  await page.getByRole("option", { name: /Analyst \(analyst\)/ }).click();
  await sheet.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(page.getByTestId("standing-team")).toHaveCount(1);
  const card = page.getByTestId("standing-team").first();
  await expect(card).toContainText("Research desk");
  await expect(card).toContainText("2 members · Coordinator: analyst");
  await expect(card).toContainText("Checker (checker)");
  expect(team("Research desk")).toMatchObject({ coordinator_member_id: "analyst", state: "active", version: 1 });

  // A second team with the same name is refused with a plain reason, and nothing is added.
  await page.getByRole("button", { name: "New team", exact: true }).first().click();
  const again = page.getByRole("dialog");
  await again.getByLabel(/^Name/).fill("research DESK");
  await again.getByTestId("plan-team").getByLabel("Role", { exact: true }).fill("Solo");
  await again.getByTestId("plan-team").getByRole("button", { name: "Add to team", exact: true }).click();
  await again.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(again.getByText(/a standing team named "research DESK" already exists/)).toBeVisible();
  await again.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("standing-team")).toHaveCount(1);

  // A person starts a mission; its plan is a proposal with one writer. Using the standing team copies its two members in.
  await page.goto(`${governor.url}/w/ws-teams/missions/new`);
  const start = page.getByRole("dialog");
  await start.getByLabel(/^What do you want done/).fill("Summarise the vendor spreadsheet");
  await start.getByText("More options", { exact: true }).click();
  await start.getByLabel("Starting tasks", { exact: true }).click();
  await page.getByRole("option", { name: "Ask me before each task", exact: true }).click();
  await start.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const missionId = (ws.prepare("SELECT id FROM missions WHERE title LIKE 'Summarise the vendor%'").get() as { id: string }).id;
  const key = "teams-plan";
  const { receipt } = await brain.executeCommand(scoped, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "plan.propose", workspaceId: "ws-teams", idempotencyKey: key,
    payload: { missionId, origin: "manual", summary: "Read the sheet, then write it up", team: [{ memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" }],
      tasks: [{ id: "read", title: "Read the vendor sheet", criteria: ["Every vendor row is read"], dependsOn: [], assignment: { kind: "agent", id: "writer", role: "specialist" } }, { id: "write", title: "Write the summary", criteria: ["The summary names each vendor"], dependsOn: ["read"], assignment: { kind: "agent", id: "writer", role: "specialist" } }] } } as never, key);
  expect(receipt.accepted).toBe(true);
  ws.prepare("INSERT INTO planning_requests(mission_id,actor_id,run_id,state,plan_version_id,created_at_ms,updated_at_ms) VALUES (?,?,?,'ready',?,?,?)")
    .run(missionId, scoped.actorId, `seed-${key}`, receipt.resourceId, brain.store.now(), brain.store.now());
  await page.goto(`${governor.url}/missions/${encodeURIComponent(missionId)}/plan`);
  await expect(page.getByText("Read the sheet, then write it up", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit steps", exact: true }).first().click();
  const editor = page.getByRole("dialog");
  const standing = editor.getByTestId("plan-standing-team");
  await expect(standing).toContainText("Use a standing team");
  await expect(standing.getByTestId("plan-standing-note")).toContainText("copied into this plan");
  await standing.getByLabel("Standing team", { exact: true }).click();
  await page.getByRole("option", { name: /Research desk/ }).click();
  await standing.getByRole("button", { name: "Add its members", exact: true }).click();
  await expect(standing.getByTestId("plan-standing-done")).toHaveText("Copied 2 members from Research desk.");
  await expect(editor.getByTestId("plan-team-member")).toHaveCount(3);
  // The copied members can take steps like any other, and the per-step eligibility rules still apply.
  await editor.getByLabel("Step 2 assigned to", { exact: true }).click();
  await page.getByRole("option", { name: /Checker \(checker\)/ }).click();
  await editor.getByRole("button", { name: "Keep edits", exact: true }).click();
  await expect(page.getByTestId("plan-assignment-changes")).toContainText("Adds Analyst (analyst), task-worker on fixture");
  await expect(page.getByTestId("plan-team-line")).toContainText("checker (Checker)");
  await page.getByRole("button", { name: "Confirm this plan", exact: true }).click();
  await expect.poll(() => (ws.prepare("SELECT state FROM plan_versions WHERE mission_id=? ORDER BY revision DESC LIMIT 1").get(missionId) as { state: string }).state).toBe("confirmed");
  const confirmedTeam = () => (JSON.parse((ws.prepare("SELECT team_json FROM plan_versions WHERE mission_id=? AND state='confirmed'").get(missionId) as { team_json: string }).team_json) as Array<{ memberId: string }>).map((member) => member.memberId);
  expect(confirmedTeam()).toEqual(["writer", "analyst", "checker"]);

  // Editing the standing team later (a third member, a new name) changes nothing that was confirmed.
  await page.goto(`${governor.url}/w/ws-teams/library/teams`);
  await page.getByRole("button", { name: "Edit Research desk", exact: true }).click();
  const editing = page.getByRole("dialog");
  await editing.getByLabel(/^Name/).fill("Research and review desk");
  await editing.getByTestId("plan-team").getByLabel("Role", { exact: true }).fill("Scribe");
  await editing.getByTestId("plan-team").getByRole("button", { name: "Add to team", exact: true }).click();
  await editing.getByRole("button", { name: "Save team", exact: true }).click();
  await expect(page.getByTestId("standing-team").first()).toContainText("3 members · Coordinator: analyst");
  expect(team("Research and review desk")).toMatchObject({ version: 2 });
  expect(confirmedTeam()).toEqual(["writer", "analyst", "checker"]);

  // A Play can be started with the team: its members become the mission's team in the plan version.
  await page.goto(`${governor.url}/w/ws-teams/missions/new`);
  const play = page.getByRole("dialog");
  await play.getByTestId("play-chips").getByRole("button").first().click();
  const choice = play.getByTestId("start-standing-team");
  await expect(choice).toContainText("Its members are copied into this mission's plan");
  await choice.getByLabel("Standing team", { exact: true }).click();
  await page.getByRole("option", { name: /Research and review desk/ }).click();
  await play.getByRole("button", { name: "Start mission", exact: true }).click();
  await expect(page).toHaveURL(/\/missions\/[^/]+\/(brief|plan)/);
  const fromPlay = ws.prepare("SELECT team_json FROM plan_versions WHERE mission_id=(SELECT id FROM missions WHERE play_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1)").get() as { team_json: string };
  expect((JSON.parse(fromPlay.team_json) as Array<{ memberId: string }>).map((member) => member.memberId)).toEqual(["analyst", "checker", "scribe"]);

  // Archiving stops new uses, keeps what was copied, and the team moves under "Archived teams".
  await page.goto(`${governor.url}/w/ws-teams/library/teams`);
  await page.getByRole("button", { name: "Archive Research and review desk", exact: true }).click();
  const archive = page.getByRole("dialog");
  await expect(archive).toContainText("Plans and missions that already copied its members are not changed.");
  await archive.getByRole("button", { name: "Archive team", exact: true }).click();
  await expect(page.getByTestId("standing-team")).toHaveCount(0);
  await page.getByRole("button", { name: "Archived teams (1)" }).click();
  await expect(page.getByTestId("standing-teams-archived")).toContainText("Research and review desk");
  expect(team("Research and review desk")).toMatchObject({ state: "archived" });
  expect(confirmedTeam()).toEqual(["writer", "analyst", "checker"]);
  await page.goto(`${governor.url}/w/ws-teams/library`);
  await expect(page.getByTestId("library-count-teams")).toHaveText("0");
  expect(errors).toEqual([]);
});
