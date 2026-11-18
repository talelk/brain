import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../core/harness";

/** `pnpm brain runner --governor <address> --token <token>`: the command Health shows joins a real Governor over HTTP. */
let harness: Harness;
let server: ReturnType<typeof serve>;
const home = mkdtempSync(join(tmpdir(), "brain-join-"));
afterAll(() => {
  server?.close();
  harness?.close();
  rmSync(home, { recursive: true, force: true });
});
beforeAll(async () => {
  harness = await createHarness();
  server = serve({ fetch: harness.governor.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((done) => server.once("listening", done));
});

const brain = (...args: string[]) => spawn(process.execPath, ["--import", "tsx", "scripts/brain.ts", ...args], { env: { ...process.env, BRAIN_HOME: home, BRAIN_PROFILE: "fixture" }, stdio: ["ignore", "pipe", "pipe"], detached: true });

describe("pnpm brain runner", () => {
  it("says what it needs when it is not told which Brain to join", async () => {
    const child = brain("runner");
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await new Promise((done) => child.once("close", done));
    expect(output).toContain("pnpm brain runner --governor <address> --token-file <file>");
  });

  it("enrols with the token of the Governor it is pointed at and appears online", async () => {
    const { token } = await harness.admin.command("runner.token", { name: "joined" });
    const child = brain("runner", "--governor", `http://127.0.0.1:${(server.address() as AddressInfo).port}`, "--token", token);
    try {
      let runner: { name: string; online: boolean; engines: readonly string[] } | undefined;
      for (let waited = 0; waited < 20_000 && !runner?.online; waited += 250) {
        await new Promise((done) => setTimeout(done, 250));
        runner = (await harness.admin.query("runners.list", {})).runners[0];
      }
      expect(runner).toMatchObject({ online: true, engines: expect.arrayContaining(["fixture"]) });
    } finally {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    }
  });
});
