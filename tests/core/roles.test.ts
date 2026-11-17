import { commands, queries, type QueryType } from "@brain/contracts";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkArtifact, putArtifact } from "../../apps/governor/src/trust/artifacts";
import { readSecret } from "../../apps/governor/src/trust/secrets";
import { tx } from "../../apps/governor/src/db";
import { createHarness, PASSWORD, type Client, type Harness } from "./harness";

let harness: Harness;
let workspaceId: string;
let otherWorkspaceId: string;
let viewer: Client;
let member: Client;
let outsider: Client;
const memory = (name: string) => ({ workspaceId, files: [{ path: `memory/${name}.md`, content: `# ${name}\n` }] });

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId } = await harness.createWorkspace({ name: "Shared" }));
  ({ workspaceId: otherWorkspaceId } = await harness.createWorkspace({ name: "Other" }));
  viewer = await harness.member(workspaceId, "vera@example.com", "viewer");
  member = await harness.member(workspaceId, "max@example.com", "member");
  // A person with an account who is a member of another workspace only.
  outsider = await harness.member(otherWorkspaceId, "omar@example.com", "admin");
});
afterAll(() => harness.close());

describe("roles", () => {
  it("every command and query declares its input and the least role it needs", () => {
    for (const entry of [...Object.values(commands), ...Object.values(queries)]) {
      expect(["public", "viewer", "member", "admin", "instance-admin"]).toContain(entry.role);
      const needsWorkspace = ["viewer", "member", "admin"].includes(entry.role);
      expect(entry.input.safeParse({}).success, `${entry.type} takes a workspace exactly when its role is a workspace role`).toBe(!needsWorkspace && !["setup.create", "workspace.create", "runner.remove"].includes(entry.type));
    }
  });

  it("every command and query refuses a person below its role, a person outside the workspace, and nobody", async () => {
    const t = { workspaceId, taskId: "t_none" };
    const valid: Record<string, object> = {
      "workspace.archive": { workspaceId }, "workspace.stopAll": { workspaceId }, "file.write": memory("roles"), "file.delete": { workspaceId, paths: ["memory/roles.md"] },
      "secret.set": { workspaceId, name: "x", value: "y" }, "secret.delete": { workspaceId, name: "x" }, "member.set": { workspaceId, email: "vera@example.com", role: "viewer" }, "member.remove": { workspaceId, userId: "u_none" },
      "task.create": { workspaceId, goal: "Do something" }, "task.confirm": t, "task.edit": { ...t, changes: [{ op: "remove", id: "t_other" }] }, "task.stop": t, "task.retry": t, "task.check": { ...t, pass: true }, "task.answer": { ...t, answer: "yes" },
      "approval.decide": { workspaceId, approvalId: "ap_none", decision: "approve", subjectDigest: "sha256:0" }, "memory.decide": { workspaceId, proposalId: "mp_none", decision: "accept" },
      "runner.remove": { runnerId: "r_none" }, "file.read": { workspaceId, path: "brain.toml" }, "task.get": t, "task.events": { ...t, attemptId: "a_none" }, "approval.get": { workspaceId, approvalId: "ap_none" },
    };
    const rank = { viewer: 0, member: 1, admin: 2 } as const;
    const refusal = async (call: Promise<unknown>): Promise<string> => call.then(() => "answered", (e: { code: string }) => e.code);
    const run = (client: Client, kind: "command" | "query", type: string, input: object): Promise<string> => refusal(kind === "command" ? client.command(type as never, input as never) : client.query(type as never, input as never));
    let checked = 0;
    for (const [kind, table] of [["command", commands], ["query", queries]] as const) {
      for (const entry of Object.values(table)) {
        if (entry.role === "public" || entry.type === "setup.create" || entry.type === "workspace.create") continue;
        const input = valid[entry.type] ?? (entry.role === "instance-admin" ? {} : { workspaceId });
        expect(await run(harness.anonymous, kind, entry.type, input), `${entry.type} for nobody`).toBe("UNAUTHENTICATED");
        if (entry.role === "instance-admin") {
          expect(await run(member, kind, entry.type, input), `${entry.type} for a workspace member`).toBe("FORBIDDEN");
          continue;
        }
        expect(await run(outsider, kind, entry.type, input), `${entry.type} for a person outside`).toBe("NOT_FOUND");
        for (const [role, client] of [["viewer", viewer], ["member", member]] as const) {
          const answer = await run(client, kind, entry.type, input);
          if (rank[role] < rank[entry.role as keyof typeof rank]) expect(answer, `${entry.type} for a ${role}`).toBe("FORBIDDEN");
          else expect(answer, `${entry.type} for a ${role}`).not.toBe("FORBIDDEN");
        }
        checked += 1;
      }
    }
    expect(checked).toBe(Object.keys(commands).length + Object.keys(queries).length - 11);
  });

  it("a viewer reads the workspace and cannot write a file", async () => {
    expect((await viewer.query("workspace.get", { workspaceId })).role).toBe("viewer");
    expect((await viewer.query("workspace.files", { workspaceId })).files.length).toBeGreaterThan(0);
    await expect(viewer.command("file.write", memory("viewer"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.command("file.delete", { workspaceId, paths: ["brain.toml"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.command("task.create", { workspaceId, goal: "Do something" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a member may start work and cannot write a file, set a secret or change members", async () => {
    // Starting work is allowed to a member: the refusal is not about their role (this workspace has no planner for a goal without a Play).
    await expect(member.command("task.create", { workspaceId, goal: "Do something" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(member.command("task.create", { workspaceId, play: "hello", inputs: { name: "Max" } })).resolves.toMatchObject({ taskId: expect.any(String) });
    await expect(member.command("file.write", memory("member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.command("secret.set", { workspaceId, name: "github", value: "a-secret-value" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.query("secrets.list", { workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.command("member.set", { workspaceId, email: "max@example.com", role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.query("members.list", { workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an admin writes files, secrets and members", async () => {
    const admin = await harness.member(workspaceId, "amy@example.com", "admin");
    await expect(admin.command("file.write", memory("admin"))).resolves.toMatchObject({ commit: expect.any(String) });
    await expect(admin.command("secret.set", { workspaceId, name: "github", value: "a-secret-value" })).resolves.toEqual({});
    expect((await admin.query("members.list", { workspaceId })).members.map((person) => [person.email, person.role])).toEqual([
      ["ada@example.com", "admin"], ["amy@example.com", "admin"], ["max@example.com", "member"], ["vera@example.com", "viewer"],
    ]);
    // An admin of a workspace is not an administrator of this Brain.
    await expect(admin.command("workspace.create", { name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.query("audit.verify", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.query("packs.list", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a person who is not a member sees nothing of the workspace", async () => {
    expect((await outsider.query("me", {})).workspaces.map((workspace) => workspace.id)).toEqual([otherWorkspaceId]);
    const reads: Array<[QueryType, object]> = [
      ["workspace.get", { workspaceId }], ["workspace.files", { workspaceId }], ["file.read", { workspaceId, path: "brain.toml" }], ["secrets.list", { workspaceId }], ["members.list", { workspaceId }],
      ["today", { workspaceId }], ["tasks.list", { workspaceId }], ["approvals.list", { workspaceId }], ["usage.summary", { workspaceId }], ["memory.list", { workspaceId }], ["health", { workspaceId }],
    ];
    for (const [type, input] of reads) await expect(outsider.query(type, input as never), type).rejects.toMatchObject({ code: "NOT_FOUND", message: "Workspace not found" });
    // The same answer as for a workspace that does not exist.
    await expect(outsider.query("workspace.get", { workspaceId: "ws_does_not_exist" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Workspace not found" });
    await expect(outsider.command("file.write", memory("outsider"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.command("secret.set", { workspaceId, name: "github", value: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nobody signed in is refused everything but setup status and me", async () => {
    await expect(harness.anonymous.query("workspace.get", { workspaceId })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(harness.anonymous.command("workspace.create", { name: "Anonymous" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await harness.anonymous.fetch("/v1/events")).status).toBe(401);
  });

  it("a request with a session cookie from another site is refused", async () => {
    const response = await harness.admin.fetch("/v1/command", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ type: "workspace.archive", input: { workspaceId }, idempotencyKey: "cross-site-1" }) });
    expect(response.status).toBe(403);
    expect((await harness.admin.query("workspace.get", { workspaceId })).status).toBe("active");
  });

  it("member.set changes a role, member.remove ends access, and the last admin stays", async () => {
    const temp = await harness.member(workspaceId, "tess@example.com", "viewer");
    expect(await harness.admin.command("member.set", { workspaceId, email: "tess@example.com", role: "member" })).toMatchObject({ created: false });
    expect((await temp.query("workspace.get", { workspaceId })).role).toBe("member");
    const tess = (await harness.admin.query("members.list", { workspaceId })).members.find((person) => person.email === "tess@example.com");
    await harness.admin.command("member.remove", { workspaceId, userId: tess?.userId ?? "" });
    await expect(temp.query("workspace.get", { workspaceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A person without an account needs a name and a first password.
    await expect(harness.admin.command("member.set", { workspaceId, email: "new@example.com", role: "viewer" })).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ path: "name" }, { path: "password" }] });
    const omar = (await outsider.query("members.list", { workspaceId: otherWorkspaceId })).members;
    const ada = omar.find((person) => person.email === "ada@example.com");
    await outsider.command("member.remove", { workspaceId: otherWorkspaceId, userId: ada?.userId ?? "" });
    await expect(outsider.command("member.set", { workspaceId: otherWorkspaceId, email: "omar@example.com", role: "viewer" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(outsider.command("member.remove", { workspaceId: otherWorkspaceId, userId: omar.find((person) => person.email === "omar@example.com")?.userId ?? "" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stored bytes are served to a member of the owning workspace only", async () => {
    const { gov } = harness.governor;
    const digest = putArtifact(gov, new TextEncoder().encode("the result"));
    tx(gov.db, () => linkArtifact(gov.db, { digest, workspaceId, name: "result.txt", kind: "output", mediaType: "text/plain" }, Date.now()));
    const served = await viewer.fetch(`/v1/artifacts/${digest}`);
    expect([served.status, await served.text(), served.headers.get("content-disposition")]).toEqual([200, "the result", "attachment; filename*=UTF-8''result.txt"]);
    expect((await outsider.fetch(`/v1/artifacts/${digest}`)).status).toBe(404);
    expect((await harness.anonymous.fetch(`/v1/artifacts/${digest}`)).status).toBe(401);
  });

  it("a change in a workspace reaches the event stream of its members only", async () => {
    const read = async (client: Client): Promise<string> => {
      const response = await client.fetch("/v1/events");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      const until = Date.now() + 1500;
      while (Date.now() < until && !text.includes("event: changed")) {
        const chunk = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 300))]);
        if (chunk?.value) text += new TextDecoder().decode(chunk.value);
      }
      void reader.cancel();
      return text;
    };
    const [forViewer, forOutsider] = [read(viewer), read(outsider)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.admin.command("file.write", memory("streamed"));
    expect(await forViewer).toContain(`event: changed\ndata: {"workspaceId":"${workspaceId}"}`);
    expect(await forOutsider).not.toContain("event: changed");
  });
});

describe("secrets", () => {
  const value = "s3cr3t-value-that-must-never-leave";
  it("are stored encrypted, listed by name only and readable by the Governor itself", async () => {
    await harness.admin.command("secret.set", { workspaceId, name: "model-main", value });
    const listed = await harness.admin.query("secrets.list", { workspaceId });
    expect(listed.secrets.map((secret) => secret.name)).toEqual(["github", "model-main"]);
    expect(readSecret(harness.governor.gov, workspaceId, "model-main")).toBe(value);
    expect(readSecret(harness.governor.gov, otherWorkspaceId, "model-main")).toBeUndefined();
    // On disk the value is not in the database, its journal or the workspace folder.
    harness.governor.gov.db.pragma("wal_checkpoint(TRUNCATE)");
    const raw = new Database(join(harness.dataDir, "brain.db"), { readonly: true });
    try {
      for (const table of ["secrets", "events", "idempotency"]) expect(JSON.stringify(raw.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(value);
      // A value copied to another workspace or name does not decrypt.
      harness.governor.gov.db.prepare("INSERT INTO secrets(workspace_id, name, value, updated_by, updated_at_ms) SELECT ?, name, value, updated_by, updated_at_ms FROM secrets WHERE workspace_id=? AND name='model-main'").run(otherWorkspaceId, workspaceId);
      expect(() => readSecret(harness.governor.gov, otherWorkspaceId, "model-main")).toThrow(/cannot be decrypted/u);
    } finally {
      raw.close();
    }
  });

  it("never appear in the output of any query", async () => {
    await harness.admin.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: 'name = "Shared"\npacks = ["extra"]\n[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "https://models.example/v1"\nmodel = "m"\nkey = "secret:model-main"\n[teams]\nwebhook = "secret:teams-webhook"\n' }] });
    expect(await harness.admin.query("secrets.list", { workspaceId })).toMatchObject({ missing: ["teams-webhook"] });
    const inputs: Partial<Record<QueryType, object>> = { "file.read": { workspaceId, path: "brain.toml" }, "task.get": { workspaceId, taskId: "t" }, "task.events": { workspaceId, taskId: "t", attemptId: "a" }, "approval.get": { workspaceId, approvalId: "a" } };
    let answered = 0;
    for (const entry of Object.values(queries)) {
      const input = inputs[entry.type] ?? (entry.input.safeParse({}).success ? {} : { workspaceId });
      const output = await harness.admin.query(entry.type, input as never).catch((e: { code?: string }) => {
        expect(e.code, entry.type).toBe("NOT_FOUND");
        return undefined;
      });
      if (output === undefined) continue;
      answered += 1;
      expect(JSON.stringify(output), entry.type).not.toContain(value);
    }
    expect(answered).toBe(Object.keys(queries).length - 3);
  });

  it("can be replaced and deleted", async () => {
    await harness.admin.command("secret.set", { workspaceId, name: "model-main", value: "another-value" });
    expect(readSecret(harness.governor.gov, workspaceId, "model-main")).toBe("another-value");
    await harness.admin.command("secret.delete", { workspaceId, name: "model-main" });
    expect(readSecret(harness.governor.gov, workspaceId, "model-main")).toBeUndefined();
    expect((await harness.admin.query("secrets.list", { workspaceId })).missing).toEqual(["model-main", "teams-webhook"]);
    expect(PASSWORD).not.toBe(value);
  });
});

describe("visibility", () => {
  const publicToml = (name: string) => `name = "${name}"\nvisibility = "public"\npacks = ["core"]\n`;
  it("a private workspace is hidden from other people, and a public one is read only for every signed-in person", async () => {
    const { workspaceId: id } = await harness.createWorkspace({ name: "Open house", packs: ["core"] });
    expect((await outsider.query("me", {})).workspaces.map((workspace) => workspace.id)).not.toContain(id);
    await expect(outsider.query("workspace.get", { workspaceId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await outsider.query("overview", {})).workspaces.map((workspace) => workspace.id)).not.toContain(id);

    await harness.admin.command("file.write", { workspaceId: id, files: [{ path: "brain.toml", content: publicToml("Open house") }] });
    const listed = (await outsider.query("me", {})).workspaces.find((workspace) => workspace.id === id);
    expect(listed).toMatchObject({ role: "viewer", visibility: "public", viaPublic: true });
    expect((await outsider.query("overview", {})).workspaces.find((workspace) => workspace.id === id)).toMatchObject({ role: "viewer", viaPublic: true, needsYou: 0 });
    expect(await outsider.query("workspace.get", { workspaceId: id })).toMatchObject({ visibility: "public", role: "viewer" });
    expect((await outsider.query("workspace.files", { workspaceId: id })).files.map((file) => file.path)).toContain("brain.toml");
    expect((await outsider.fetch(`/v1/workspaces/${id}/files/brain.toml`)).status).toBe(200);
    expect((await outsider.query("schedules.list", {})).schedules.every((item) => item.role === "viewer" || item.workspaceId !== id)).toBe(true);
    // Read only: no command, and nothing that holds secrets or people.
    const attempts = [
      () => outsider.command("file.write", { workspaceId: id, files: [{ path: "memory/x.md", content: "# x\n" }] }), () => outsider.command("task.create", { workspaceId: id, goal: "Do it" }),
      () => outsider.query("secrets.list", { workspaceId: id }), () => outsider.query("members.list", { workspaceId: id }), () => outsider.command("member.set", { workspaceId: id, email: "omar@example.com", role: "admin" }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await harness.anonymous.fetch(`/v1/workspaces/${id}/files/brain.toml`)).status).toBe(401);
    // The change was audited, and making it private again hides it.
    const audited = harness.governor.gov.db.prepare("SELECT payload_json AS p FROM events WHERE type='workspace.visibility' AND workspace_id=?").all(id) as Array<{ p: string }>;
    expect(audited.map((event) => JSON.parse(event.p).visibility)).toEqual(["public"]);
    await harness.admin.command("file.write", { workspaceId: id, files: [{ path: "brain.toml", content: 'name = "Open house"\npacks = ["core"]\n' }] });
    await expect(outsider.query("workspace.get", { workspaceId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a member keeps their own role in a public workspace", async () => {
    const { workspaceId: id } = await harness.createWorkspace({ name: "Open team", packs: ["core"] });
    const mine = await harness.member(id, "meg@example.com", "member");
    await harness.admin.command("file.write", { workspaceId: id, files: [{ path: "brain.toml", content: publicToml("Open team") }] });
    expect((await mine.query("me", {})).workspaces.find((workspace) => workspace.id === id)).toMatchObject({ role: "member", viaPublic: false, visibility: "public" });
    await expect(mine.command("task.create", { workspaceId: id, play: "hello", inputs: { name: "Meg" } })).resolves.toBeDefined();
  });
});
