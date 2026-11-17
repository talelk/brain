import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { enrolRunner } from "./driver";
import { createHarness, PASSWORD, startGovernor, type Harness } from "./harness";
import { makeWorkspace } from "./work";

let harness: Harness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});

describe("first-run setup", () => {
  it("a fresh Governor needs setup and keeps a one-time token only its owner can read", async () => {
    const { governor, dataDir, client } = await startGovernor();
    try {
      expect(await client().query("setup.status", {})).toEqual({ setupRequired: true });
      expect(await client().query("me", {})).toEqual({ user: null, workspaces: [] });
      expect(statSync(join(dataDir, "setup.token")).mode & 0o077).toBe(0);
      await expect(client().command("setup.create", { token: "not-the-token", name: "Eve", email: "eve@example.com", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(client().command("setup.create", { token: readFileSync(join(dataDir, "setup.token"), "utf8").trim(), name: "Eve", email: "eve@example.com", password: "short" })).rejects.toMatchObject({ code: "INVALID_INPUT", problems: [{ path: "password" }] });
      expect(await client().query("setup.status", {})).toEqual({ setupRequired: true });
    } finally {
      governor.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("setup.create makes the first person the instance admin, signs them in and can not be repeated", async () => {
    harness = await createHarness();
    expect(await harness.anonymous.query("setup.status", {})).toEqual({ setupRequired: false });
    expect(await harness.admin.query("me", {})).toEqual({ user: { id: expect.any(String), name: "Ada Admin", email: "ada@example.com", instanceAdmin: true }, workspaces: [] });
    expect(existsSync(join(harness.dataDir, "setup.token"))).toBe(false);
    await expect(harness.anonymous.command("setup.create", { token: "anything", name: "Eve", email: "eve@example.com", password: PASSWORD })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("with the packs Brain ships, setup also makes the Starter workspace from the base pack, with the new person as its admin", async () => {
    harness = await createHarness({ packsDir: fileURLToPath(new URL("../../packs", import.meta.url)) });
    const { workspaces } = await harness.admin.query("me", {});
    expect(workspaces).toMatchObject([{ slug: "starter", name: "Starter", role: "admin", status: "active" }]);
    const workspaceId = workspaces[0]?.id ?? "";
    const { snapshot } = await harness.admin.query("workspace.get", { workspaceId });
    expect([snapshot.packs, Object.keys(snapshot.plays), Object.keys(snapshot.agents).sort()]).toEqual([["base"], ["hello"], ["checker", "planner", "worker", "workspace-healer"]]);
    expect((await harness.admin.query("workspace.files", { workspaceId })).files.filter((file) => file.source === "workspace").map((file) => file.path)).toEqual(["brain.toml"]);
    // The sample goal is the base pack's `hello` Play: it can be started at once.
    const { taskId } = await harness.admin.command("task.create", { workspaceId, play: "hello" });
    expect((await harness.admin.query("task.get", { workspaceId, taskId })).subtasks).toMatchObject([{ stepId: "describe", agent: "worker", state: "ready" }]);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("while no runner is enrolled, a Governor told where leaves a one-use runner token only its owner can read", async () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), "brain-run-")), "runner.token");
    harness = await createHarness({ localRunnerTokenFile: tokenFile });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const enroll = (): Promise<Response> => harness!.anonymous.fetch("/runner/v1/enroll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: readFileSync(tokenFile, "utf8").trim(), name: "the bundled runner", publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() }),
    });
    expect((await enroll()).status).toBe(200);
    expect((await enroll()).status).toBe(403);
    expect((await harness.admin.query("runners.list", {})).runners).toMatchObject([{ name: "the bundled runner" }]);
    // A runner is enrolled now: the next start leaves no token.
    rmSync(tokenFile);
    await harness.restart();
    expect(existsSync(tokenFile)).toBe(false);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("engines are given the model gateway at the address sandboxes reach the Governor by, when that is not the address people use", async () => {
    harness = await createHarness({ gatewayUrl: "http://host.docker.internal:3100/" });
    const { workspaceId } = await makeWorkspace(harness, "Sandboxed", { agents: { dev: {} }, plays: { one: 'title = "One"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Do the work."\n' } });
    const driver = await enrolRunner(harness);
    await harness.admin.command("task.create", { workspaceId, play: "one" });
    expect((await driver.claim())?.model.gatewayUrl).toBe("http://host.docker.internal:3100/model/v1");
  });

  it("the person can sign in again with their password, and nobody can sign up from outside", async () => {
    harness = await createHarness();
    const again = await harness.signIn("ada@example.com");
    expect((await again.query("me", {})).user?.email).toBe("ada@example.com");
    await expect(harness.signIn("ada@example.com", "a wrong password")).rejects.toThrow(/sign-in/u);
    const signUp = await harness.anonymous.fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Eve", email: "eve@example.com", password: PASSWORD }) });
    expect(signUp.status).toBe(403);
  });

  it("a restart keeps the setup, the session and the data", async () => {
    harness = await createHarness();
    const { workspaceId } = await harness.createWorkspace();
    await harness.restart();
    expect(await harness.anonymous.query("setup.status", {})).toEqual({ setupRequired: false });
    expect((await harness.admin.query("me", {})).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
  });

  it("a command or query that does not exist is refused, and nobody signed in reads nothing", async () => {
    harness = await createHarness();
    const { workspaceId } = await harness.createWorkspace();
    await expect(harness.admin.command("no.such" as never, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(harness.admin.query("no.such" as never, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(harness.anonymous.query("today", { workspaceId })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
