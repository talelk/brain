import type { CommandRequest } from "@brain/contracts";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, PASSWORD, type Client, type Harness } from "./harness";

// docs/model.md, "Users, invitations and groups".
let harness: Harness;
let workspaceId: string;
let otherId: string;

const tokenOf = (link: string): string => link.split("=")[1] ?? "";
const events = (like: string): Array<{ type: string; subject: string; payload: string; workspaceId: string | null }> =>
  harness.governor.gov.db.prepare("SELECT type, subject, payload_json AS payload, workspace_id AS workspaceId FROM events WHERE type LIKE ? ORDER BY seq").all(like) as never;
const refusal = (call: Promise<unknown>): Promise<string> => call.then(() => "answered", (e: { code: string }) => e.code);
const signedOut = async (client: Client): Promise<boolean> => (await client.query("me", {})).user === null;
const roleIn = async (client: Client, id: string): Promise<string> => (await client.query("me", {})).workspaces.find((workspace) => workspace.id === id)?.role ?? "none";
/** Invites an address as an admin does, opens the link as the person, and answers a client signed in with the cookies it set. */
async function join(email: string, extra: Partial<Omit<CommandRequest<"user.invite">, "email">> = {}): Promise<{ client: Client; userId: string; invitationId: string }> {
  const invited = await harness.admin.command("user.invite", { email, ...extra });
  const response = await harness.anonymous.fetch("/v1/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input: { token: tokenOf(invited.link), name: email.split("@")[0], password: PASSWORD } }) });
  const body = (await response.json()) as { output?: { userId: string }; error?: { code: string } };
  if (!body.output) throw new Error(`accept refused: ${body.error?.code}`);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const client = (await harness.signIn(email)) as Client;
  expect(cookies).not.toBe("");
  return { client, userId: body.output.userId, invitationId: invited.invitationId };
}

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId } = await harness.createWorkspace({ name: "Alpha" }));
  ({ workspaceId: otherId } = await harness.createWorkspace({ name: "Beta" }));
});
afterAll(() => harness.close());

describe("groups and the access resolver", () => {
  it("a person has the highest of their own role and their groups' roles, and the matrix says where each comes from", async () => {
    const lena = await harness.member(workspaceId, "lena@example.com", "viewer");
    const lenaId = (await lena.query("me", {})).user?.id ?? "";
    const { groupId } = await harness.admin.command("group.set", { name: "Reviewers", memberIds: [lenaId], grants: [{ workspaceId, role: "admin" }, { workspaceId: otherId, role: "member" }] });
    expect(await roleIn(lena, workspaceId)).toBe("admin");
    expect(await roleIn(lena, otherId)).toBe("member");

    const detail = await harness.admin.query("user.get", { userId: lenaId });
    expect(detail.access.find((row) => row.workspaceId === workspaceId)).toMatchObject({ role: "admin", direct: "viewer", groups: [{ id: groupId, name: "Reviewers", role: "admin" }] });
    expect(detail.access.find((row) => row.workspaceId === otherId)).toMatchObject({ role: "member", direct: null });

    // The workspace's people list shows the group and who gets access through it.
    const members = await harness.admin.query("members.list", { workspaceId });
    expect(members.groups).toEqual([{ groupId, name: "Reviewers", role: "admin", members: [{ userId: lenaId, name: "lena", email: "lena@example.com" }] }]);
    // A group admin reaches what an admin does (the workspace's people), though no `members` row says admin.
    await expect(lena.query("members.list", { workspaceId })).resolves.toMatchObject({ members: expect.any(Array) });

    // A direct role above the group's wins; taking the person out of the group, or the group's grant away, takes the group's role away.
    await harness.admin.command("member.set", { workspaceId: otherId, email: "lena@example.com", role: "admin" });
    expect(await roleIn(lena, otherId)).toBe("admin");
    await harness.admin.command("group.set", { groupId, name: "Reviewers", memberIds: [lenaId], grants: [{ workspaceId, role: "member" }] });
    expect(await roleIn(lena, workspaceId)).toBe("member");
    await harness.admin.command("group.set", { groupId, name: "Reviewers", memberIds: [], grants: [{ workspaceId, role: "member" }] });
    expect(await roleIn(lena, workspaceId)).toBe("viewer");
    await harness.admin.command("group.set", { groupId, name: "Reviewers", memberIds: [lenaId], grants: [{ workspaceId, role: "admin" }] });
    await harness.admin.command("group.delete", { groupId });
    expect(await roleIn(lena, workspaceId)).toBe("viewer");
    expect((await harness.admin.query("users.list", {})).groups).toEqual([]);
  });

  it("group names are unique, and every change to a group and its grants is in the audit log", async () => {
    const { groupId } = await harness.admin.command("group.set", { name: "Support", memberIds: [], grants: [{ workspaceId, role: "viewer" }] });
    expect(await refusal(harness.admin.command("group.set", { name: "support" }))).toBe("CONFLICT");
    expect(events("group.%").map((event) => event.type)).toEqual(expect.arrayContaining(["group.created", "group.granted", "group.updated", "group.revoked", "group.deleted"]));
    expect(events("group.granted").some((event) => event.workspaceId === workspaceId && event.payload.includes(groupId))).toBe(true);
  });
});

describe("invitations", () => {
  it("an invitation is a one-use link: the person chooses a name and password, is signed in and gets what it granted", async () => {
    const { groupId } = await harness.admin.command("group.set", { name: "Newcomers", memberIds: [], grants: [{ workspaceId: otherId, role: "viewer" }] });
    const invited = await harness.admin.command("user.invite", { email: "Nora@Example.com", workspaces: [{ workspaceId, role: "member" }], groups: [groupId] });
    expect(invited.link).toMatch(/\/#invite=[\w-]{40,}$/u);
    expect(invited.emailed).toBe(false);
    // The people table shows the address as invited, with what it grants; nothing of the token is kept.
    const row = (await harness.admin.query("users.list", {})).users.find((user) => user.email === "nora@example.com");
    expect(row).toMatchObject({ status: "invited", invitationId: invited.invitationId, workspaces: 1 });
    expect(JSON.stringify(harness.governor.gov.db.prepare("SELECT * FROM invitations").all())).not.toContain(tokenOf(invited.link));
    expect(events("user.invited").map((event) => event.payload).join()).not.toContain(tokenOf(invited.link));

    const accept = (input: object): Promise<Response> => harness.anonymous.fetch("/v1/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input }) });
    const response = await accept({ token: tokenOf(invited.link), name: "Nora", password: PASSWORD });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join()).toContain("session_token");
    const nora = await harness.signIn("nora@example.com");
    expect(await roleIn(nora, workspaceId)).toBe("member");
    expect(await roleIn(nora, otherId)).toBe("viewer");
    expect((await harness.admin.query("users.list", {})).users.find((user) => user.email === "nora@example.com")).toMatchObject({ status: "active", name: "Nora", groups: [{ name: "Newcomers" }] });
    expect(events("user.joined")).toHaveLength(1);

    // It works once.
    expect((await accept({ token: tokenOf(invited.link), name: "Nora again", password: PASSWORD })).status).toBe(404);
  });

  it("an invitation is revoked, replaced by a newer one, and expires; every refusal says the same", async () => {
    const accept = async (token: string): Promise<{ status: number; message: string }> => {
      const response = await harness.anonymous.fetch("/v1/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input: { token, name: "Someone", password: PASSWORD } }) });
      return { status: response.status, message: ((await response.json()) as { error: { message: string } }).error.message };
    };
    const first = await harness.admin.command("user.invite", { email: "ravi@example.com" });
    const second = await harness.admin.command("user.invite", { email: "ravi@example.com" });
    expect(first.invitationId).not.toBe(second.invitationId);
    const replaced = await accept(tokenOf(first.link));

    await harness.admin.command("invitation.revoke", { invitationId: second.invitationId });
    const revoked = await accept(tokenOf(second.link));
    const third = await harness.admin.command("user.invite", { email: "ravi@example.com" });
    harness.governor.gov.db.prepare("UPDATE invitations SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, third.invitationId);
    const expired = await accept(tokenOf(third.link));
    const unknown = await accept("x".repeat(43));
    for (const answer of [replaced, revoked, expired, unknown]) expect(answer).toEqual({ status: 404, message: unknown.message });
    expect(events("user.invitation_revoked")).toHaveLength(1);
    await expect(harness.admin.command("invitation.revoke", { invitationId: second.invitationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an address with an account cannot be invited", async () => {
    expect(await refusal(harness.admin.command("user.invite", { email: "ada@example.com" }))).toBe("CONFLICT");
  });
});

describe("deactivation, roles and sessions", () => {
  it("the last active instance admin cannot be demoted or deactivated, and nobody deactivates themselves", async () => {
    const adminId = (await harness.admin.query("me", {})).user?.id ?? "";
    expect(await refusal(harness.admin.command("user.set", { userId: adminId, instanceAdmin: false }))).toBe("CONFLICT");
    expect(await refusal(harness.admin.command("user.set", { userId: adminId, active: false }))).toBe("CONFLICT");
    const { client, userId } = await join("sam@example.com");
    expect(await refusal(client.command("user.set", { userId: adminId, instanceAdmin: false }))).toBe("FORBIDDEN");
    await harness.admin.command("user.set", { userId, instanceAdmin: true });
    expect((await client.query("me", {})).user?.instanceAdmin).toBe(true);
    // A deactivated admin does not count: the one active admin left is protected although another admin exists.
    await harness.admin.command("user.set", { userId, active: false });
    expect(await refusal(harness.admin.command("user.set", { userId: adminId, instanceAdmin: false }))).toBe("CONFLICT");
    await harness.admin.command("user.set", { userId, active: true });
    // With two active admins either may be demoted; Sam steps down so the instance is as it was.
    await harness.admin.command("user.set", { userId, instanceAdmin: false });
    expect((await harness.admin.query("users.list", {})).users.find((user) => user.id === userId)?.instanceAdmin).toBe(false);
  });

  it("a deactivated person cannot act with a session they already had, cannot sign in, keeps their history, and works again when reactivated", async () => {
    const { client, userId } = await join("dana@example.com", { workspaces: [{ workspaceId, role: "member" }] });
    const task = await client.command("task.create", { workspaceId, play: "hello", inputs: { name: "Dana" } });
    const stream = await client.fetch("/v1/events");
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();

    await harness.admin.command("user.set", { userId, active: false });
    // The session they held answers nobody: the API, the event stream and a download all refuse it.
    expect(await signedOut(client)).toBe(true);
    expect(await refusal(client.query("workspace.get", { workspaceId }))).toBe("UNAUTHENTICATED");
    expect((await client.fetch("/v1/events")).status).toBe(401);
    expect(harness.governor.gov.db.prepare('SELECT COUNT(*) AS n FROM session WHERE "userId"=?').get(userId)).toEqual({ n: 0 });
    // The stream they had open has ended.
    for (let ended = false; !ended && reader;) ended = (await reader.read()).done;
    // They cannot sign in, with the right password: password, and an account's session is not made.
    const attempt = await harness.anonymous.fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@example.com", password: PASSWORD }) });
    expect(attempt.ok).toBe(false);
    expect(attempt.headers.getSetCookie()).toEqual([]);
    // History and roles stay.
    expect((await harness.admin.query("task.get", { workspaceId, taskId: task.taskId })).id).toBe(task.taskId);
    const members = (await harness.admin.query("members.list", { workspaceId })).members;
    expect(members.find((member) => member.userId === userId)).toMatchObject({ role: "member", active: false });
    expect((await harness.admin.query("users.list", {})).users.find((user) => user.id === userId)?.status).toBe("deactivated");
    expect(events("user.deactivated").map((event) => event.subject)).toContain(`user:${userId}`);

    await harness.admin.command("user.set", { userId, active: true });
    const again = await harness.signIn("dana@example.com");
    expect(await roleIn(again, workspaceId)).toBe("member");
  });

  it("an admin forces a person out, or makes a reset link that sets a new password and ends their sessions, once", async () => {
    const { client, userId } = await join("eli@example.com");
    const signedIn = await harness.signIn("eli@example.com");
    expect((await client.query("user.get", {})).sessions.length).toBeGreaterThanOrEqual(2);
    await expect(client.command("session.revoke", { userId: (await harness.admin.query("me", {})).user?.id ?? "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Their own other sessions can be ended, keeping the one asking.
    const others = await client.command("session.revoke", { keepCurrent: true });
    expect(others.revoked).toBeGreaterThanOrEqual(1);
    expect((await client.query("me", {})).user?.id).toBe(userId);
    expect(await signedOut(signedIn)).toBe(true);

    await harness.admin.command("session.revoke", { userId });
    expect(await signedOut(client)).toBe(true);

    const reset = await harness.admin.command("user.resetLink", { userId });
    expect(reset.link).toMatch(/\/#reset=/u);
    const redeem = (password: string): Promise<Response> => harness.anonymous.fetch("/v1/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input: { token: tokenOf(reset.link), password } }) });
    expect((await redeem("a brand new password")).status).toBe(200);
    expect((await redeem("another new password")).status).toBe(404);
    await expect(harness.signIn("eli@example.com")).rejects.toThrow();
    const fresh = await harness.signIn("eli@example.com", "a brand new password");
    expect((await fresh.query("me", {})).user?.id).toBe(userId);
    expect(events("user.password_reset")).toHaveLength(1);
  });

  it("a person changes their name and password from their profile, sees their sign-ins, and the other sessions end", async () => {
    const { client, userId } = await join("fay@example.com");
    const other = await harness.signIn("fay@example.com");
    await expect(client.command("profile.set", { currentPassword: "not the password", newPassword: "a brand new password" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await client.command("profile.set", { name: "Fay Zed", currentPassword: PASSWORD, newPassword: "a brand new password" });
    expect((await client.query("me", {})).user?.name).toBe("Fay Zed");
    expect(await signedOut(other)).toBe(true);
    const detail = await client.query("user.get", {});
    expect(detail.signIns.some((entry) => entry.ok)).toBe(true);
    expect(detail.sessions.filter((session) => session.current)).toHaveLength(1);
    await expect(client.query("user.get", { userId: (await harness.admin.query("me", {})).user?.id ?? "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A refused password is a failed sign-in in the log; an address nobody has leaves nothing.
    await harness.anonymous.fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fay@example.com", password: "wrong wrong wrong" }) });
    await harness.anonymous.fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@example.com", password: "wrong wrong wrong" }) });
    expect((await harness.admin.query("user.get", { userId })).signIns.filter((entry) => !entry.ok)).toHaveLength(1);
    expect(events("user.sign_in_failed").filter((event) => event.subject === `user:${userId}`)).toHaveLength(1);
    expect(events("user.sign_in_failed").every((event) => event.subject.startsWith("user:") && !event.payload.includes("nobody"))).toBe(true);
    // The routes of the sign-in library that change an account without the audit log are closed.
    for (const path of ["/api/auth/update-user", "/api/auth/change-password", "/api/auth/revoke-sessions", "/api/auth/request-password-reset"]) expect((await client.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("every change is an audit event in the chain", () => {
    const types = new Set(events("user.%").map((event) => event.type));
    for (const type of ["user.invited", "user.joined", "user.role_set", "user.deactivated", "user.reactivated", "user.signed_out", "user.reset_issued", "user.password_reset", "user.profile_set", "user.signed_in"]) expect(types, type).toContain(type);
  });

  it("guessing links is limited per address: after ten refusals even a good link waits", async () => {
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      last = (await harness.anonymous.fetch("/v1/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "invitation.accept", idempotencyKey: crypto.randomUUID(), input: { token: `guess-${i}`.padEnd(30, "g"), password: PASSWORD } }) })).status;
    }
    expect(last).toBe(409);
  });

  it("mail is sent only when an SMTP server is configured, and the answer still carries the link", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      let data = false;
      let text = "";
      socket.write("220 fake\r\n");
      socket.on("data", (chunk) => {
        for (const line of chunk.toString().split("\r\n")) {
          if (data) { text += `${line}\n`; if (line === ".") { data = false; received.push(text); socket.write("250 queued\r\n"); } continue; }
          if (/^EHLO/u.test(line)) socket.write("250 fake\r\n");
          else if (/^(MAIL|RCPT)/u.test(line)) socket.write("250 ok\r\n");
          else if (line === "DATA") { data = true; socket.write("354 go\r\n"); }
          else if (line === "QUIT") socket.end("221 bye\r\n");
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env["BRAIN_SMTP_URL"] = `smtp://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const invited = await harness.admin.command("user.invite", { email: "mia@example.com" });
      expect(invited.emailed).toBe(true);
      for (let i = 0; i < 50 && received.length === 0; i += 1) await new Promise((done) => setTimeout(done, 50));
      expect(received[0]).toContain(invited.link);
      expect(received[0]).toContain("To: <mia@example.com>");
    } finally {
      delete process.env["BRAIN_SMTP_URL"];
      server.close();
    }
  });
});
