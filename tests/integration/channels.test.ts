import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld } from "../helpers";

// T32 packet acceptance: one command/query surface across channels. HTTP and
// MCP execute identical handlers (same idempotency), humans are refused on
// the MCP channel, and approval decisions do not exist there by design.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("channel parity (T32)", () => {
  it("MCP refuses humans and approval decisions; agent command/query matches HTTP exactly", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-channels-")), allowTestActor: true });
    const brain = app.brain;
    const w = setupWorld(brain);
    brain.ensurePrincipal(w.org, "agent-1", "agent");
    brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'agent-1', 'operator', 1, 'owner-1', ?)")
      .run(w.workspaceId, w.org, brain.store.now());

    const call = (path: string, principal: string, body: unknown) => app!.fetch(new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-brain-test-actor": `${principal}:${w.org}` },
      body: JSON.stringify(body),
    }));
    const command = {
      contractVersion: "brain.command/v1", commandId: "cmd-chan-1", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "chan-1",
      payload: { title: "Channel parity card", criteria: ["c1"] },
    };

    // Humans cannot use the MCP channel at all.
    const humanMcp = await call("/mcp", "owner-1", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { query: { queryType: "today", workspaceId: w.workspaceId } } });
    expect(humanMcp.status).toBe(403);

    // Agent query over MCP works and returns the same envelope family.
    const agentQuery = await call("/mcp", "agent-1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { query: { queryType: "today", workspaceId: w.workspaceId } } });
    expect(agentQuery.status).toBe(200);
    const agentQueryBody = (await agentQuery.json()) as { result: { queryType: string } };
    expect(agentQueryBody.result.queryType).toBe("today");

    // The same command over MCP then HTTP is one idempotent execution.
    const viaMcp = await call("/mcp", "agent-1", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { command } });
    expect(viaMcp.status).toBe(200);
    const mcpReceipt = ((await viaMcp.json()) as { result: Record<string, unknown> }).result;
    const viaHttp = await call("/v1/commands", "agent-1", command);
    expect(viaHttp.status).toBeLessThan(300);
    const httpBody = (await viaHttp.json()) as { receipt?: Record<string, unknown> } & Record<string, unknown>;
    const httpReceipt = (httpBody["receipt"] ?? httpBody) as Record<string, unknown>;
    expect(httpReceipt["resourceId"]).toBe(mcpReceipt["resourceId"]);
    const cards = brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS c FROM cards WHERE title='Channel parity card'").get() as { c: number };
    expect(cards.c).toBe(1);

    // Approval decisions are absent from MCP by design, even for agents.
    const decision = await call("/mcp", "agent-1", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { command: { ...command, commandId: "cmd-chan-2", commandType: "approval.revoke", idempotencyKey: "chan-2", payload: {} } },
    });
    expect(decision.status).toBe(403);
    expect(await decision.clone().text()).toMatch(/not available over MCP/);
  }, 120_000);
});
