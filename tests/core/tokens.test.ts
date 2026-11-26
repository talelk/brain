import { commands, PUBLISHED, queries, TOKEN_MAY, type CommandType, type QueryType } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverNotifications } from "../../apps/governor/src/integrations/teams";
import { webhooksSettled } from "../../apps/governor/src/integrations/webhook";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { makeWorkspace, pass } from "./work";

/** API tokens (docs/model.md): another system's credential, for one workspace, as a viewer or a member, never doing what waits for a person. */
let harness: Harness;
let driver: Driver;
let workspaceId: string;
let otherId: string;
const sent: Array<{ type: string; subject: string }> = [];

beforeAll(async () => {
  harness = await createHarness({
    fetch: (input, init) => {
      if (String(input).startsWith("https://ci.example.test/")) sent.push(JSON.parse(String(init?.body)) as { type: string; subject: string });
      return Promise.resolve(Response.json({}));
    },
  });
  ({ workspaceId } = await makeWorkspace(harness, "Driven", {
    brain: '[webhook]\nurl = "https://ci.example.test/brain"\nsecret = "secret:brain-webhook"\n',
    agents: { dev: {} }, plays: { one: 'title = "One step"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Do the work."\napprove = true\n' },
  }));
  ({ workspaceId: otherId } = await makeWorkspace(harness, "Open to all", { brain: 'visibility = "public"\n' }));
  await harness.admin.command("secret.set", { workspaceId, name: "brain-webhook", value: "shared-signing-secret" });
  driver = await enrolRunner(harness, { checker: () => pass(), dev: () => "Done." });
});
afterAll(() => harness.close());

/** A client that calls with this token and nothing else. */
const withToken = (token: string, base: Client = harness.anonymous): Client => {
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const response = await base.fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const answer = (await response.json()) as { output?: unknown; error?: { code: string; message: string } };
    if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.output;
  };
  let key = 0;
  return {
    fetch: (path, init = {}) => base.fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } }),
    command: (type, input) => call("/v1/command", { type, input, idempotencyKey: `${type}-${token.slice(-8)}-${(key += 1)}` }) as never,
    query: (type, input) => call("/v1/query", { type, input }) as never,
  };
};
const make = (role: "viewer" | "member", name: string = role) => harness.admin.command("token.create", { workspaceId, name, role });

describe("an API token", () => {
  it("starts and follows work in its workspace, is told of it, and is refused what waits for a person", async () => {
    const made = await make("member", "pipeline");
    const system = withToken(made.token);
    const { taskId } = await system.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    await deliverNotifications(harness.governor.gov);
    await webhooksSettled(harness.governor.gov);
    expect(sent).toEqual([expect.objectContaining({ type: "brain.task.needs_you" })]);

    const record = await system.query("task.get", { workspaceId, taskId });
    expect(record.createdByName).toBe("pipeline");
    const waiting = record.subtasks[0]?.id ?? "";
    await expect(system.command("task.check", { workspaceId, taskId: waiting, pass: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(system.command("approval.decide", { workspaceId, approvalId: "ap_any", decision: "approve", subjectDigest: "sha256:any" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await system.command("task.stop", { workspaceId, taskId });

    const actors = harness.governor.gov.db.prepare("SELECT DISTINCT actor_kind AS kind, actor_id AS id FROM events WHERE subject=? AND actor_kind IN ('person','token')").all(`task:${taskId}`);
    expect(actors).toEqual([{ kind: "token", id: `token:${made.tokenId}` }]);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("may call nothing that decides, edits or manages: what it may is named, and the rest is closed", async () => {
    const system = withToken((await make("member")).token);
    const closed = [...Object.keys(commands).filter((type) => !TOKEN_MAY.commands.includes(type as CommandType)), ...Object.keys(queries).filter((type) => !TOKEN_MAY.queries.includes(type as QueryType))];
    for (const type of ["task.confirm", "task.check", "task.answer", "task.checkpoint", "approval.decide", "memory.decide", "file.write", "file.delete", "secret.set", "member.set", "token.create", "profile.set", "session.revoke", "invitation.accept", "setup.create", "user.get", "members.list", "secrets.list", "tokens.list"]) expect(closed).toContain(type);
    for (const type of TOKEN_MAY.commands) expect(PUBLISHED.commands).toContain(type);
    for (const type of TOKEN_MAY.queries) expect(PUBLISHED.queries).toContain(type);
    for (const type of TOKEN_MAY.commands) expect((commands[type] as { role: string }).role, type).toBe("member");
    for (const type of TOKEN_MAY.queries) expect(["viewer", "public"], type).toContain((queries[type] as { role: string }).role);
    await expect(system.query("user.get", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(system.command("profile.set", { name: "Somebody" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(system.command("secret.set", { workspaceId, name: "x", value: "y" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("holds its role in its own workspace only, a public one included", async () => {
    const viewer = withToken((await make("viewer")).token);
    await expect(viewer.command("task.create", { workspaceId, goal: "Do something" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.query("tasks.list", { workspaceId: otherId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await viewer.query("me", {})).toMatchObject({ user: { name: "viewer", instanceAdmin: false }, workspaces: [{ id: workspaceId, role: "viewer" }] });
    expect((await viewer.query("overview", {})).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
    // Only commands and queries take a token.
    expect((await viewer.fetch("/v1/events")).status).toBe(401);
  });

  it("stops holding when it is revoked or expires, even beside a signed-in session", async () => {
    const revoked = await make("viewer", "revoked");
    await harness.admin.command("token.revoke", { workspaceId, tokenId: revoked.tokenId });
    await expect(withToken(revoked.token).query("me", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(withToken(revoked.token, harness.admin).query("me", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(withToken("brn_not-a-token").query("me", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const short = await harness.admin.command("token.create", { workspaceId, name: "short", role: "viewer", days: 1 });
    harness.governor.gov.db.prepare("UPDATE api_tokens SET expires_at_ms=? WHERE id=?").run(harness.governor.gov.clock.nowMs() - 1, short.tokenId);
    await expect(withToken(short.token).query("me", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const { tokens } = await harness.admin.query("tokens.list", { workspaceId });
    expect(tokens.find((token) => token.id === revoked.tokenId)).toMatchObject({ name: "revoked", role: "viewer", createdByName: "Ada Admin", revokedAt: expect.any(Number) as number });
    expect(JSON.stringify(tokens)).not.toContain(revoked.token);
    expect(harness.governor.gov.db.prepare("SELECT 1 FROM api_tokens WHERE token_digest=? OR name=?").get(revoked.token, revoked.token)).toBeUndefined();
  });

  it("is made by an admin only, and never as one", async () => {
    const member = await harness.member(workspaceId, "mo@example.com", "member");
    await expect(member.command("token.create", { workspaceId, name: "mine", role: "member" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.admin.command("token.create", { workspaceId, name: "root", role: "admin" as "member" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
