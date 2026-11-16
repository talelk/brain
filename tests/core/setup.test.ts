import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, PASSWORD, startGovernor, type Harness } from "./harness";

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
