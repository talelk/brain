import { test, expect } from "./fixtures";
import { seedHuman } from "../helpers";
import { signUpOwner } from "../support/flow";

// A first-time user hands a mission to a teammate from the mission page (#117): the menu offers it, the dialog lists only people who can work
// on missions, the new owner is named in the confirmation, the Governor records the hand-over and the audit trail says from whom to whom.
test("mission owner transfer: hand a mission to a teammate from the mission page", async ({ page, governor }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { brain, actor, cookie } = await signUpOwner(page, governor, "handover");
  brain.createWorkspace(actor, { workspaceId: "ws-hand", slug: "hand" });
  const ws = (await brain.resolveActor(new Headers({ cookie }), "ws-hand")).actor;
  const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await brain.executeCommand(ws, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: "ws-hand", idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const workspaceVersion = () => (brain.store.control.prepare("SELECT version FROM workspaces WHERE id='ws-hand'").get() as { version: number }).version;
  // Two teammates: Dana can work on missions, Vic only reads.
  for (const [id, name, role] of [["dana", "Dana Cole", "operator"], ["vic", "Vic Reader", "viewer"]] as const) {
    seedHuman(brain, actor.organizationId, id);
    brain.store.control.prepare('UPDATE "user" SET name=? WHERE id=?').run(name, id);
    await command("member.grant", `grant-${id}`, { principalId: id, role, reason: "teammate" }, workspaceVersion());
  }
  const missionId = (await command("mission.create", "h-create", { title: "Compare two venues", intent: "Compare two venues", successCriteria: ["Both venues are compared"] })).resourceId ?? "";
  const owner = async () => ((await brain.executeQuery(ws, { queryType: "missions.get", workspaceId: "ws-hand", resourceId: missionId })) as unknown as { snapshot: { ownerId: string } }).snapshot.ownerId;
  expect(await owner()).toBe(actor.actorId);

  await page.goto(`${governor.url}/missions/${missionId}/live?w=ws-hand`);
  await expect(page.getByRole("heading", { name: "Compare two venues" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hand this mission to someone else" }).click();
  const dialog = page.getByRole("dialog", { name: "Hand this mission over" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("The new owner receives its attention items and notifications");
  await expect(dialog.getByRole("button", { name: "Hand over", exact: true })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "New owner" }).click();
  // Only people who can work on missions are offered: Dana, not the read-only Vic, and not the current owner.
  await expect(page.getByRole("option", { name: /Dana Cole/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Vic Reader/ })).toHaveCount(0);
  await page.getByRole("option", { name: /Dana Cole/ }).click();
  await dialog.screenshot({ path: test.info().outputPath("handover-dialog.png") });
  await dialog.getByRole("button", { name: "Hand over", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("This mission now belongs to Dana Cole.")).toBeVisible();
  expect(await owner()).toBe("dana");
  const trail = ((await brain.executeQuery(ws, { queryType: "audit.list", workspaceId: "ws-hand" })) as unknown as { snapshot: { items: Array<{ action: string; actorId: string; message?: string }> } }).snapshot.items;
  expect(trail.find((entry) => entry.action === "mission.ownerTransferred")).toMatchObject({ actorId: actor.actorId, message: expect.stringMatching(/to Dana Cole$/u) });
  // The organization owner is a workspace administrator, so the mission can still be handed on from here.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Hand this mission to someone else" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
