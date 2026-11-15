import { createHmac } from "node:crypto";
import { test, expect } from "./fixtures";
import { fixtureStarter } from "../support/starter";
import { signUpOwner } from "../support/flow";
import { seedHuman } from "../helpers";

/**
 * Spec #90 ticket #123: an administrator links a chat user to a member under People, Chat identities. Until then a "start" from that chat
 * user is refused in words that name the id to link; after it the same message starts a mission as that member (its plan waiting for them),
 * and unlinking ends it. The administrator only uses the screen; the chat messages arrive as the signed hook receives them.
 */
const SECRET = "browser-inbound-secret-0123456789";

test("an administrator links a Slack user to a member, who then starts a mission from chat; unlinking ends it", async ({ page, governor }) => {
  test.setTimeout(150_000);
  process.env["BRAIN_INBOUND_WEBHOOK_SECRET"] = SECRET;
  process.env["BRAIN_BASE_URL"] = governor.url;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { brain, actor } = await signUpOwner(page, governor, "chat");
  brain.createWorkspace(actor, { workspaceId: "ws-chat", slug: "chat" });
  const starter = fixtureStarter();
  brain.activateRelease(actor, brain.stageRelease(actor, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
  // Ana is a member of the organization and an operator in the workspace (people join through invitations, covered elsewhere).
  seedHuman(brain, actor.organizationId, "ana");
  brain.store.control.prepare('UPDATE "user" SET name=?, email=? WHERE id=?').run("Ana Costa", "ana@example.test", "ana");
  brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-chat', ?, 'ana', 'operator', 1, ?, ?)").run(actor.organizationId, actor.actorId, brain.store.now());
  const missionCount = () => (brain.store.workspaceDb("ws-chat", actor.organizationId).prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n;
  const slack = async (text: string, triggerId: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({ text, user_id: "U024ANA", user_name: "ana.costa", trigger_id: triggerId }).toString();
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const response = await page.request.post(`${governor.url}/hooks/chat`, { headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature }, data: body });
    return (await response.json() as { text: string }).text;
  };

  // Nobody is linked yet: the section says so, and a chat "start" is refused with the id the administrator needs.
  await page.goto(`${governor.url}/settings?tab=people`);
  await expect(page.getByRole("heading", { name: "People", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  const section = page.locator("[data-chat-identities]");
  await expect(page.getByRole("heading", { name: "Chat identities" })).toBeVisible();
  await expect(section.locator("[data-chat-empty]")).toHaveText("Nobody is linked yet, so nobody can start missions from chat.");
  expect(await slack("start research-and-write", "t-before")).toContain('link "U024ANA" under Administration, People, Chat identities');
  expect(missionCount()).toBe(0);

  // The administrator links the Slack id to Ana; the button waits for both fields.
  const link = section.getByRole("button", { name: "Link to member", exact: true });
  await expect(link).toBeDisabled();
  await section.getByLabel(/^Chat user id/).fill("U024ANA");
  await expect(link).toBeDisabled();
  await section.getByLabel("Organization member").click();
  await page.getByRole("option", { name: /Ana Costa/ }).click();
  await expect(link).toBeEnabled();
  await link.click();
  await expect(section.getByRole("status")).toHaveText("Linked. That person can now start missions from chat.");
  const row = section.locator('[data-chat-identity="slack:U024ANA"]');
  await expect(row).toContainText("Slack");
  await expect(row).toContainText("Linked to Ana Costa");

  // Ana's message now starts a mission as her, and links to it; a repeat of the same message starts nothing more.
  const reply = await slack("start research-and-write Compare two venues", "t-start");
  expect(reply).toContain('Started "Compare two venues" from research-and-write.');
  expect(reply).toContain("waits for you in Needs you");
  expect(await slack("start research-and-write Compare two venues", "t-start")).toBe(reply);
  expect(missionCount()).toBe(1);
  const link1 = /(https?:\/\/\S+\/missions\/[^\s]+)/u.exec(reply)?.[1] ?? "";
  await page.goto(link1);
  await expect(page.getByRole("heading", { name: "Compare two venues" }).first()).toBeVisible({ timeout: 30_000 });
  expect(brain.store.workspaceDb("ws-chat", actor.organizationId).prepare("SELECT owner_id FROM missions").get()).toEqual({ owner_id: "ana" });

  // Unlinking ends it.
  await page.goto(`${governor.url}/settings?tab=people`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await section.getByRole("button", { name: "Unlink U024ANA", exact: true }).click();
  await expect(section.getByRole("status")).toHaveText("Unlinked. That chat user can no longer start missions.");
  await expect(section.locator("[data-chat-empty]")).toBeVisible();
  expect(await slack("start research-and-write", "t-after")).toContain("not linked to a Brain member");
  expect(missionCount()).toBe(1);
  expect(errors).toEqual([]);
});
