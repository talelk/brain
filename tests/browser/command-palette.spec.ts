import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

type Governor = { url: string; credential: string; app: { brain: import("../../apps/governor/src/application/brain").Brain } };

/**
 * The command palette (#103, stories 24-25), walked like a first-time owner using only the keyboard: sign up, press Control-K,
 * see the actions, run one, find a mission and a task by title and open each in its place, and go to a mission's other
 * views. At phone width the header's search button opens the same palette. Work is made through the commands the screens send.
 */
async function world(page: Page, governor: Governor) {
  await page.goto(governor.url);
  await page.getByLabel(/^Setup credential/).fill(governor.credential);
  await page.getByLabel(/^Organization name/).fill("Palette organization");
  await page.getByLabel(/^Email/).fill("palette@example.test");
  await page.getByLabel(/^Password/).fill("browser-password-1234");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create your first workspace" })).toBeVisible();
  const brain = governor.app.brain;
  const cookie = (await page.context().cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const owner = (await brain.resolveActor(new Headers({ cookie }))).actor;
  brain.createWorkspace(owner, { workspaceId: "ws-palette", slug: "palette" });
  const actor = (await brain.resolveActor(new Headers({ cookie }), "ws-palette")).actor;
  let count = 0;
  const run = async (commandType: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<string> => {
    const key = `palette-${commandType}-${++count}`;
    const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: key, commandType, workspaceId: "ws-palette", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key);
    if (!receipt.accepted) throw new Error(`${commandType} was refused`);
    return receipt.resourceId ?? "";
  };
  const missionId = await run("mission.create", { title: "Launch the website", intent: "Launch the website", successCriteria: ["Done well"], autoStart: false });
  const planId = await run("plan.propose", { missionId, origin: "manual", tasks: [{ id: "copy", title: "Write the announcement", criteria: ["copy verified"], dependsOn: [] }] });
  const version = ((await brain.executeQuery(actor, { queryType: "missions.get", workspaceId: "ws-palette", resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
  await run("plan.confirm", { planVersionId: planId }, version);
  const item = ((await brain.executeQuery(actor, { queryType: "workItems.list", workspaceId: "ws-palette", limit: 10 })) as unknown as { snapshot: { items: Array<{ workItemId: string }> } }).snapshot.items[0]!.workItemId;
  return { missionId, item };
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Find work or run an action" })).toBeVisible();
}

test("palette: run actions, find a mission and a task by title, go to a mission view, all from the keyboard", async ({ page, governor }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { missionId, item } = await world(page, governor);
  const phone = (info.project.use.viewport?.width ?? 1440) < 600;

  await page.goto(`${governor.url}/w/ws-palette/missions`);
  await expect(page.getByRole("heading", { name: "Missions" }).first()).toBeVisible();
  if (phone) await page.getByRole("button", { name: /^Search Brain/ }).click();
  else await openPalette(page);
  const dialog = page.getByRole("dialog", { name: "Find work or run an action" });
  await expect(dialog).toBeVisible();

  // With nothing typed the palette already offers its actions, in plain words.
  for (const name of ["New mission", "Open approvals", "Open Live"]) await expect(page.getByRole("option", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(page).toHaveScreenshot(`command-palette-actions.png`, { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });

  // Typing narrows the actions; the keyboard runs one.
  await page.keyboard.type("approvals");
  await expect(page.getByRole("option", { name: /^Open approvals/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Open Live/ })).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/approvals$/);

  // A mission is found by its title and opens on its own page.
  await openPalette(page);
  await page.keyboard.type("website");
  const mission = page.getByRole("option", { name: /Launch the website/ });
  await expect(mission).toBeVisible();
  await expect(mission).toContainText("Mission");
  await expect(page).toHaveScreenshot(`command-palette-results.png`, { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" });
  await mission.click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}`));
  await expect(page.getByRole("heading", { name: "Launch the website" }).first()).toBeVisible();

  // A task is found by its title and opens inside its mission, selected by the address.
  await openPalette(page);
  await page.keyboard.type("announcement");
  const task = page.getByRole("option", { name: /Write the announcement/ });
  await expect(task).toContainText("Task");
  await task.click();
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/plan\\?.*item=${item}`));
  await expect(page.getByText("Write the announcement").first()).toBeVisible();

  // On a mission page the palette offers that mission's other views; Brief is one keystroke sequence away.
  await openPalette(page);
  await page.keyboard.type("go to brief");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/brief`));

  // What nothing matches says so, plainly.
  await openPalette(page);
  await page.keyboard.type("zzzqq");
  await expect(page.getByText("Nothing you can read matches.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Find work or run an action" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
