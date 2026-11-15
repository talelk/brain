import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld } from "../helpers";
import { confirmedMission, register, running, stageStarter } from "../support/machine-session";
import { scaled } from "../support/timing";

// An MCP client's view of Brain at the HTTP seam: initialize, tools/list, tools/call for a read and a write, as the signed-in person.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

interface Reply { jsonrpc: string; id: unknown; result?: Record<string, unknown> & { isError?: boolean; structuredContent?: Record<string, unknown>; tools?: { name: string; inputSchema: Record<string, unknown> }[] }; error?: { code: number; message: string } }

describe("MCP server", () => {
  it("a standard client initializes, lists tools and calls reads and commands as the signed-in person", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-mcp-")), allowTestActor: true });
    const w = setupWorld(app.brain);
    let rpcId = 0;
    const rpc = async (method: string, params: unknown, principal: string | null = "owner-1") => {
      const res = await app!.fetch(new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(principal ? { "x-brain-test-actor": `${principal}:${w.org}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      }));
      return { status: res.status, body: (res.status === 200 ? await res.json() : await res.text()) as Reply };
    };

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "brain" } });
    const notified = await app.fetch(new Request("http://127.0.0.1:3000/mcp", { method: "POST", headers: { "content-type": "application/json", "x-brain-test-actor": `owner-1:${w.org}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(notified.status).toBe(202);

    const list = await rpc("tools/list", {});
    const tools = list.body.result!.tools!;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["command.mission.create", "query.missions.list", "query.search.global"]));
    expect(names.some((n) => n.startsWith("command.approval.") && n !== "command.approval.request")).toBe(false);
    const create = tools.find((t) => t.name === "command.mission.create")!;
    expect(create.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["workspaceId", "idempotencyKey", "payload"]) });

    // A command, as the person: and a repeat with the same key is one execution.
    const args = { workspaceId: w.workspaceId, idempotencyKey: "mcp-1", payload: { title: "Over MCP", intent: "A standard client starts a mission", successCriteria: ["c1"] } };
    const made = await rpc("tools/call", { name: "command.mission.create", arguments: args });
    expect(made.body.result!.isError).toBe(false);
    const receipt = made.body.result!.structuredContent!;
    expect(receipt["accepted"]).toBe(true);
    const again = await rpc("tools/call", { name: "command.mission.create", arguments: args });
    expect(again.body.result!.structuredContent!["resourceId"]).toBe(receipt["resourceId"]);

    // A read tool sees what the command made.
    const read = await rpc("tools/call", { name: "query.missions.list", arguments: { workspaceId: w.workspaceId } });
    expect(read.body.result!.isError).toBe(false);
    expect(JSON.stringify(read.body.result!.structuredContent)).toContain(String(receipt["resourceId"]));

    // Refusals: bad arguments and a step-up command without its step-up are tool errors; an approval decision is not offered.
    const bad = await rpc("tools/call", { name: "command.mission.create", arguments: { workspaceId: w.workspaceId, idempotencyKey: "mcp-2", payload: {} } });
    expect(bad.body.result!.isError).toBe(true);
    const stepUp = await rpc("tools/call", { name: "command.workspace.sessions.stopAll", arguments: { workspaceId: w.workspaceId, idempotencyKey: "mcp-3", payload: { workspaceId: w.workspaceId, reason: "stop", stepUpEvidenceId: "never-verified" } } });
    expect(stepUp.body.result!.isError).toBe(true);
    expect(JSON.stringify(stepUp.body.result!.structuredContent)).toMatch(/step-up|APPROVAL/i);
    const decision = await rpc("tools/call", { name: "command.approval.revoke", arguments: { workspaceId: w.workspaceId, idempotencyKey: "mcp-4", payload: {} } });
    expect(decision.body.result!.isError).toBe(true);
    expect(JSON.stringify(decision.body.result!.structuredContent)).toMatch(/not available over MCP/);
    expect((await rpc("tools/call", { name: "command.nope", arguments: {} })).body.error?.code).toBe(-32602);
    expect((await rpc("resources/list", {})).body.error?.code).toBe(-32601);

    // Not signed in: refused before any tool runs.
    const anonymous = await rpc("tools/list", {}, null);
    expect(anonymous.status).toBe(401);
    // A person without a role in the workspace is refused by the authorization matrix, not by the channel.
    app.brain.ensurePrincipal(w.org, "outsider-1", "human");
    const outsider = await rpc("tools/call", { name: "command.mission.create", arguments: { ...args, idempotencyKey: "mcp-5" } }, "outsider-1");
    expect(outsider.status === 200 ? outsider.body.result!.isError : true).toBe(true);
  }, scaled(120_000));

  it("a session credential over /mcp runs only its allowlisted commands and never an approval decision", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-mcp-session-")), allowTestActor: true });
    const w = setupWorld(app.brain);
    stageStarter(w);
    const runner = register(w, "runner-mcp");
    const { missionId, workItemId } = await confirmedMission(w);
    const offer = running(w, runner, "mcp");
    const credential = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).credential;
    let rpcId = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await app!.fetch(new Request("http://127.0.0.1:3000/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }));
      expect(res.status).toBe(200);
      const reply = (await res.json()) as Reply; expect(reply.error, name).toBeUndefined(); return reply.result!;
    };
    const refusedCommands: [string, Record<string, unknown>][] = [
      ["command.mission.pause", { missionId }],
      ["command.mission.close", { missionId }],
      ["command.workspace.spendCap.set", { dailyMicroUsd: 1 }],
      ["command.plan.confirm", { planVersionId: "none" }],
      ["command.approval.request", {}],
      ["command.approval.revoke", {}],
    ];
    for (const [name, payload] of refusedCommands) {
      const result = await call(name, { workspaceId: w.workspaceId, idempotencyKey: `s-${name}`, payload });
      expect(result.isError, name).toBe(true);
    }
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get()).toEqual({ n: 0 });
    // The one behind a Brain tool is admitted.
    const allowed = await call("command.workItem.comment", { workspaceId: w.workspaceId, idempotencyKey: "s-note", payload: { workItemId, text: "From a session over MCP" } });
    expect(allowed.isError).toBe(false);
    expect(allowed.structuredContent).toMatchObject({ accepted: true });
  }, scaled(120_000));
});
