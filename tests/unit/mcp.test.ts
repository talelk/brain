import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "../../apps/mcp/src/config";
import { CALLED, createServer as createMcp } from "../../apps/mcp/src/tools";
import { PUBLISHED } from "../../packages/contracts/src/api";

interface Seen { path: string; cookie: string | undefined; body: Record<string, unknown> }

/** A stub Brain: sign-in sets a cookie; the first request after `expire()` answers 401; `refuse` answers a command with an error. */
const stubBrain = async (refuse?: object) => {
  const seen: Seen[] = [];
  let expired = false;
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      seen.push({ path: request.url ?? "", cookie: request.headers.cookie, body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/auth/sign-in/email") {
        response.setHeader("set-cookie", `session=s${seen.length}; Path=/; HttpOnly`).end("{}");
      } else if (expired) {
        expired = false;
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "sign in" } }));
      } else if (refuse !== undefined && request.url === "/v1/command") {
        response.statusCode = 422;
        response.end(JSON.stringify({ error: refuse }));
      } else {
        response.end(JSON.stringify({ output: { echo: body.type } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, expire: () => { expired = true; }, close: () => server.close() };
};

const open = async (url: string, readonly = false) => {
  const [near, far] = InMemoryTransport.createLinkedPair();
  await createMcp({ url, email: "a@b.c", password: "pw" }, readonly).connect(far);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(near);
  return client;
};
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("the MCP server", () => {
  it("calls the entries the published API holds, and no other", () => {
    const called = (kind: string): string[] => CALLED.filter((tool) => tool.kind === kind).map((tool) => tool.type).sort();
    expect({ queries: called("query"), commands: called("command") }).toEqual({ queries: [...PUBLISHED.queries].sort(), commands: [...PUBLISHED.commands].sort() });
  });

  const closers: Array<() => void> = [];
  afterEach(() => { for (const close of closers.splice(0)) close(); });

  it("offers the reads and the writes, but no approval, memory decision or secret, and only the reads in read-only mode", async () => {
    const brain = await stubBrain();
    closers.push(brain.close);
    const names = (await (await open(brain.url)).listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("brain_insights");
    expect(names).toContain("brain_file_write");
    expect(names.filter((name) => /approval|memory|secret|user/u.test(name))).toEqual([]);
    const readOnly = (await (await open(brain.url, true)).listTools()).tools;
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(names.length).toBeGreaterThan(readOnly.length);
  });

  it("signs in once, sends a query and a command as the API takes them, and signs in again when the session ends", async () => {
    const brain = await stubBrain();
    closers.push(brain.close);
    const client = await open(brain.url);
    expect(text(await client.callTool({ name: "brain_tasks_list", arguments: { workspaceId: "w1", state: "failed" } }))).toContain("tasks.list");
    const query = brain.seen.find((entry) => entry.path === "/v1/query")!;
    expect(query.cookie).toBe("session=s1");
    expect(query.body).toMatchObject({ type: "tasks.list", input: { workspaceId: "w1", state: "failed", limit: 50 } });
    await client.callTool({ name: "brain_task_stop", arguments: { workspaceId: "w1", taskId: "t1" } });
    const command = brain.seen.filter((entry) => entry.path === "/v1/command").at(-1)!;
    expect(command.body).toMatchObject({ type: "task.stop", input: { workspaceId: "w1", taskId: "t1" } });
    expect(String(command.body.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    brain.expire();
    await client.callTool({ name: "brain_overview", arguments: {} });
    expect(brain.seen.filter((entry) => entry.path === "/api/auth/sign-in/email")).toHaveLength(2);
    expect(brain.seen.at(-1)!.cookie).toBe("session=s5");
  });

  it("reports a refusal with the files to fix, and an input the contract refuses before any request", async () => {
    const brain = await stubBrain({ code: "INVALID_WORKSPACE", message: "the folder is not valid", problems: [{ path: "agents/x/agent.toml", message: "unknown key" }] });
    closers.push(brain.close);
    const client = await open(brain.url);
    const refused = (await client.callTool({ name: "brain_file_write", arguments: { workspaceId: "w1", files: [{ path: "agents/x/agent.toml", content: "x" }] } })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("INVALID_WORKSPACE: the folder is not valid\n- agents/x/agent.toml: unknown key");
    const before = brain.seen.length;
    const invalid = (await client.callTool({ name: "brain_task_create", arguments: { workspaceId: "w1" } })) as { isError?: boolean };
    expect(invalid.isError).toBe(true);
    expect(brain.seen.length).toBe(before);
  });

  it("reads credentials from a dotenv file under either set of names", () => {
    expect(parseEnvFile("# c\nexport BRAIN_LIVE_ADMIN_EMAIL='a@b.c'\nBRAIN_LIVE_ADMIN_PASSWORD=\"p w\"\n")).toEqual({ BRAIN_LIVE_ADMIN_EMAIL: "a@b.c", BRAIN_LIVE_ADMIN_PASSWORD: "p w" });
  });
});
