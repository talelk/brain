import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerConfig } from "../../apps/runner/src/config";
import { Runner } from "../../apps/runner/src/runner";
import { createHarness, type Client, type Harness } from "../core/harness";
import { getTask, makeWorkspace } from "../core/work";
import { tempDir } from "../runner/git-repo";
import { startMcpServer, TICKET_INPUT, TICKET_OUTPUT, type TestMcpServer } from "../runner/mcp-server";

/** An external MCP tool through the real runner and the real Governor: it is called only once a person approved exactly that call. */
let harness: Harness;
let server: TestMcpServer;
let member: Client;
let workspaceId: string;
let runner: Runner;
let whileWaiting: () => Promise<void> = () => Promise.resolve();
const waited = { ms: 0 };

beforeAll(async () => {
  server = await startMcpServer("mcp-secret-token");
  harness = await createHarness();
  ({ workspaceId } = await makeWorkspace(harness, "Tracker", {
    agents: { operator: {} },
    plays: { report: 'title = "Report"\n[[step]]\nid = "report"\nagent = "operator"\ngoal = """Report it.\nFIXTURE @work tool tickets.create {"title": "The cart is empty"}\nFIXTURE @work reply %last%"""\n' },
  }));
  await harness.admin.command("file.write", { workspaceId, files: [
    { path: "agents/operator/agent.toml", content: 'description = "Operates the tracker."\nengine = ["fixture"]\ntools = ["tickets.create"]\n' },
    { path: "tools/tickets.create/tool.toml", content: `description = "Creates a ticket."\neffect = "write"\nnetwork = ["${server.host}"]\nsecrets = ["tickets"]\n[mcp]\nurl = "${server.url}"\ntool = "create_ticket"\n` },
    { path: "tools/tickets.create/input.schema.json", content: JSON.stringify(TICKET_INPUT) },
    { path: "tools/tickets.create/output.schema.json", content: JSON.stringify(TICKET_OUTPUT) },
  ] });
  await harness.admin.command("secret.set", { workspaceId, name: "tickets", value: "mcp-secret-token" });
  member = await harness.member(workspaceId, "max@example.com", "member");
  const cfg: RunnerConfig = {
    governorUrl: "http://localhost:3100", stateDir: tempDir("e2e-mcp"), name: "the real runner", enrollToken: (await harness.admin.command("runner.token", {})).token, capabilities: ["bash", "python3", "curl"], engines: ["fixture"], slots: 1,
    attemptTimeoutMs: 30_000, sandbox: { cpuMillicores: 1000, memoryMb: 1024 }, unsandboxedForTests: true, approval: { timer: { now: () => waited.ms, sleep: async (ms) => { waited.ms += ms; await whileWaiting(); } }, pollMs: 10, waitMs: 30 },
    transport: (input, init) => Promise.resolve(harness.governor.app.fetch(new Request(input as string, init))),
  };
  runner = await Runner.connect(cfg);
});
afterAll(async () => {
  harness.close();
  await server.close();
});

describe("an external MCP tool that changes something", () => {
  it("reaches its server only after a person approved the call, and its answer is in the record", async () => {
    let calledBeforeApproval = -1;
    whileWaiting = async () => {
      for (const approval of (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals) {
        calledBeforeApproval = server.calls.length;
        expect(approval).toMatchObject({ tool: "tickets.create", effect: "write" });
        await member.command("approval.decide", { workspaceId, approvalId: approval.id, decision: "approve", subjectDigest: approval.subjectDigest });
      }
    };
    const { taskId } = await member.command("task.create", { workspaceId, play: "report" });
    while (await runner.runOnce()) { /* the work, then its check */ }
    expect(calledBeforeApproval).toBe(0);
    expect(server.calls).toEqual([{ name: "create_ticket", arguments: { title: "The cart is empty" } }]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task.state).toBe("done");
    expect(task.toolCalls).toMatchObject([{ tool: "tickets.create", effect: "write", outcome: "succeeded", output: { id: 7, title: "The cart is empty" } }]);
    expect(JSON.stringify(task)).not.toContain("mcp-secret-token");
  });
});
