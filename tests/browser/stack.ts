import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { CommandRequest, CommandOutputs, CommandType, QueryOutputs, QueryRequest, QueryType } from "@brain/contracts";
import { createGovernor, type Governor } from "../../apps/governor/src/app";
import type { RunnerConfig } from "../../apps/runner/src/config";
import { Runner } from "../../apps/runner/src/runner";

/**
 * What a browser test runs against: a Governor on a temporary data directory, serving the built web app on a free port, and the real runner on
 * the fixture engine in the same process. A test gets its own, empty, install.
 */
export const PASSWORD = "correct horse battery";
export const NAME = "Maya Haddad";
export const EMAIL = "maya@example.com";

export interface Api {
  command<T extends CommandType>(type: T, input: CommandRequest<T>): Promise<CommandOutputs[T]>;
  query<T extends QueryType>(type: T, input: QueryRequest<T>): Promise<QueryOutputs[T]>;
}
export interface Stack {
  readonly url: string;
  /** What the install prints on a fresh data directory. */
  readonly setupLink: string;
  /** Creates the first account the way the setup page does and answers an API that acts as that person. */
  setUp(): Promise<Api>;
  /** The Starter workspace's id, once there is an account. */
  readonly runnerName: string;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

async function startStack(): Promise<{ stack: Stack; stop(): Promise<void> }> {
  const base = join(process.env["TMPDIR"] ?? join(homedir(), ".cache", "brain-tmp"));
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, "brain-browser-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const tokenFile = join(home, "runner.token");
  const governor: Governor = await createGovernor({ dataDir: join(home, "data"), baseUrl: url, localRunnerTokenFile: tokenFile });
  const server: Server = serve({ fetch: governor.app.fetch, port, hostname: "127.0.0.1" }) as Server;
  await new Promise((done) => server.once("listening", done));
  governor.startTimers();

  // The real runner, on the fixture engine standing in for the engines the packs name. Two slots, claiming at once instead of every two seconds.
  const config: RunnerConfig = {
    governorUrl: url, stateDir: join(home, "runner"), name: "browser runner", enrollToken: readFileSync(tokenFile, "utf8").trim(), capabilities: ["bash", "python3", "curl", "git"], engines: ["fixture"],
    fixtureFor: ["pi", "claude", "opencode", "codex"], slots: 2, attemptTimeoutMs: 60_000, sandbox: { cpuMillicores: 1000, memoryMb: 512 }, unsandboxedForTests: true, approval: { pollMs: 250, waitMs: 20_000 },
  };
  const runner = await Runner.connect(config);
  let stopping = false;
  const loops = [
    ...[0, 1].map(async () => { while (!stopping) { try { if (!(await runner.runOnce())) await sleep(100); } catch { await sleep(500); } } }),
    (async () => { while (!stopping) { await runner.heartbeat().catch(() => undefined); await sleep(5000); } })(),
  ];
  await runner.heartbeat();

  const stack: Stack = {
    url, setupLink: `${url}/#token=${readFileSync(join(home, "data", "setup.token"), "utf8").trim()}`, runnerName: config.name,
    async setUp() {
      const response = await fetch(`${url}/v1/command`, {
        method: "POST", headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ type: "setup.create", idempotencyKey: crypto.randomUUID(), input: { token: readFileSync(join(home, "data", "setup.token"), "utf8").trim(), name: NAME, email: EMAIL, password: PASSWORD } }),
      });
      if (!response.ok) throw new Error(`setup failed: ${await response.text()}`);
      const cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
      const call = async (path: string, body: object): Promise<never> => {
        const answer = (await (await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: url, cookie }, body: JSON.stringify(body) })).json()) as { output?: never; error?: { message: string } };
        if (answer.error) throw new Error(answer.error.message);
        return answer.output as never;
      };
      return { command: (type, input) => call("/v1/command", { type, input, idempotencyKey: crypto.randomUUID() }), query: (type, input) => call("/v1/query", { type, input }) };
    },
  };
  return {
    stack,
    async stop() {
      stopping = true;
      await Promise.race([Promise.all(loops), sleep(1000)]);
      server.closeAllConnections();
      server.close();
      governor.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export const test = base.extend<{ stack: Stack }>({
  stack: async ({}, use) => {
    const running = await startStack();
    try { await use(running.stack); } finally { await running.stop(); }
  },
});
export { expect };

/** Signs in on the sign-in page as the person `setUp` made, and lands on Today. */
export async function signIn(page: Page, stack: Stack): Promise<void> {
  await page.goto(stack.url);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What do you want done?" })).toBeVisible();
}

/** The Starter workspace the first setup made, and what a test writes into it before the person arrives. */
export async function starter(api: Api): Promise<{ id: string; write(files: Record<string, string>): Promise<void>; connectModel(): Promise<void> }> {
  const id = (await api.query("me", {})).workspaces[0]?.id ?? "";
  const write = async (files: Record<string, string>): Promise<void> => {
    await api.command("file.write", { workspaceId: id, files: Object.entries(files).map(([path, content]) => ({ path, content })) });
  };
  return {
    id, write,
    async connectModel() {
      const { content } = await api.query("file.read", { workspaceId: id, path: "brain.toml" });
      await write({ "brain.toml": `${content}\n[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "http://127.0.0.1:9/v1"\nmodel = "fixture-model"\n` });
    },
  };
}
