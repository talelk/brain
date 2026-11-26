import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkspace } from "../../apps/governor/src/workspace/load";
import { writeMcpTools } from "../../scripts/mcp-tools";
import { tempDir } from "./git-repo";
import { startMcpServer, TICKET_INPUT, TICKET_OUTPUT, type TestMcpServer } from "./mcp-server";
import { runnerWorld } from "./world";

/** A tool of an external MCP server (docs/model.md, "A tool"): the runner's own client calls it where it runs any script. */
let server: TestMcpServer;
beforeAll(async () => { server = await startMcpServer("mcp-secret-token"); });
afterAll(() => server.close());

describe("an MCP tool", () => {
  const run = async (tool: { name: string; remote: string; outputs?: boolean; token?: string }, input: object) => {
    const { gov, runner } = await runnerWorld();
    gov.secrets["tickets"] = tool.token ?? "mcp-secret-token";
    const offered = gov.tool(tool.name, { mcp: { url: server.url, tool: tool.remote }, secrets: ["tickets"], network: [server.host], inputSchema: TICKET_INPUT, ...(tool.outputs ? { outputSchema: TICKET_OUTPUT } : {}) });
    const offer = gov.offer({ tools: [{ ...offered, inputSchema: tool.remote === "create_ticket" ? TICKET_INPUT : { type: "object" } }], task: { goal: `FIXTURE tool ${tool.name} ${JSON.stringify(input)}\nFIXTURE reply %last%` } });
    await runner.runOnce();
    return { result: gov.eventsOf(offer.attemptId, "tool.result")[0], said: gov.completions.get(offer.attemptId)?.result ?? "" };
  };

  it("calls the server's tool with the call's input and the secret as its token, and gives back its structured result", async () => {
    const { result, said } = await run({ name: "tickets.create", remote: "create_ticket", outputs: true }, { title: "The cart is empty", labels: ["bug"] });
    expect(result).toMatchObject({ outcome: "succeeded", output: { id: 7, title: "The cart is empty" } });
    expect(server.calls.at(-1)).toEqual({ name: "create_ticket", arguments: { title: "The cart is empty", labels: ["bug"] } });
    expect(said).not.toContain("mcp-secret-token");
  });

  it("gives back a tool's text when it answers with no structure", async () => {
    expect((await run({ name: "tickets.search", remote: "search.tickets" }, { query: "cart" })).result).toMatchObject({ outcome: "succeeded", output: { text: "two tickets\nasked: cart" } });
  });

  it("fails the call, saying why, when the input does not fit, the tool reports an error, the result does not fit or the server refuses", async () => {
    const before = server.calls.length;
    expect((await run({ name: "tickets.create", remote: "create_ticket" }, { title: "no" })).result).toMatchObject({ outcome: "failed", output: { error: expect.stringContaining('"title"') as string } });
    expect(server.calls.length).toBe(before);
    expect((await run({ name: "tickets.create", remote: "create_ticket" }, { title: "broken" })).result).toMatchObject({ outcome: "failed", output: { error: "the tracker is closed" } });
    expect((await run({ name: "tickets.create", remote: "create_ticket", outputs: true }, { title: "odd" })).result).toMatchObject({ outcome: "failed", output: { error: expect.stringContaining('"id" must be of type integer') as string } });
    expect((await run({ name: "tickets.create", remote: "create_ticket", token: "wrong-token" }, { title: "Anything" })).result).toMatchObject({ outcome: "failed", output: { error: expect.stringContaining("the server answered 401") as string } });
  });
});

describe("pnpm brain mcp-tools", () => {
  it("writes each of a server's tools as a folder that waits for a person, which a workspace loads", async () => {
    const out = tempDir("mcp-tools");
    expect(await writeMcpTools({ url: server.url, system: "tickets", out, token: "mcp-secret-token" })).toEqual(["tickets.create-ticket", "tickets.search-tickets"]);
    const files = new Map<string, Uint8Array>([["brain.toml", new TextEncoder().encode('name = "T"\n')]]);
    for (const name of ["tickets.create-ticket", "tickets.search-tickets"]) {
      for (const file of readdirSync(join(out, "tools", name))) files.set(`tools/${name}/${file}`, new Uint8Array(readFileSync(join(out, "tools", name, file))));
    }
    const loaded = loadWorkspace(files, tempDir("no-packs"));
    expect(loaded.problems).toEqual([]);
    // The server calls its first tool read only; Brain takes no server's word for that.
    expect(loaded.manifest?.tools["tickets.create-ticket"]).toMatchObject({ effect: "privileged", secrets: ["tickets"], network: [server.host], needs: ["bash", "python3", "curl"], mcp: { url: server.url, tool: "create_ticket" }, input_schema: TICKET_INPUT, output_schema: TICKET_OUTPUT });
    await expect(writeMcpTools({ url: server.url, system: "tickets", out, token: "mcp-secret-token" })).rejects.toThrow(/already exists/u);
  });
});
