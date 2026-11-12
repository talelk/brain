import { describe, expect, it } from "vitest";
import { setupWorld } from "../helpers";

interface CallsSnapshot { toolId: string; items: Array<{ proposalId: string; runId: string; outcome: string; message?: string; diagnosis?: { cause: string; headline: string; nextStep: string } }>; causes: Array<{ cause: string; count: number }> }

describe("per-tool call history with diagnosis", () => {
  it("lists recent calls newest first, explains failures, flags calls with no result and groups failures by cause", async () => {
    const w = setupWorld();
    const insert = w.brain.store.control.prepare("INSERT INTO tool_calls(attempt_id, proposal_id, organization_id, workspace_id, run_id, tool_id, proposed_at, failed, finished_at, failure_message) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const row = (proposal: string, tool: string, at: string, failed: number, finished: string | null, message: string | null) => insert.run(`att-${proposal}`, proposal, w.org, w.workspaceId, `run-${proposal}`, tool, at, failed, finished, message);
    row("p1", "host.read", "2026-11-12T08:00:01.000Z", 0, "2026-11-12T08:00:02.000Z", null);
    row("p2", "host.read", "2026-11-12T08:00:03.000Z", 1, "2026-11-12T08:00:04.000Z", "that file or folder is not readable through this tool (secrets, databases and backups are kept out)");
    row("p3", "host.read", "2026-11-12T08:00:05.000Z", 1, "2026-11-12T08:00:06.000Z", "that path is outside the readable area");
    row("p4", "host.read", "2026-11-12T08:00:07.000Z", 0, null, null);
    row("p5", "web.fetch", "2026-11-12T08:00:08.000Z", 1, "2026-11-12T08:00:09.000Z", "host example.com is not on this tool's allowlist");
    const snapshot = ((await w.brain.executeQuery(w.owner, { queryType: "tools.calls", workspaceId: w.workspaceId, resourceId: "host.read", limit: 10 } as never)) as unknown as { snapshot: CallsSnapshot }).snapshot;
    expect(snapshot.toolId).toBe("host.read");
    expect(snapshot.items.map((item) => [item.proposalId, item.outcome])).toEqual([["p4", "no-result"], ["p3", "failed"], ["p2", "failed"], ["p1", "succeeded"]]);
    expect(snapshot.items[0]!.diagnosis?.cause).toBe("no-result");
    expect(snapshot.items[1]!.diagnosis).toMatchObject({ cause: "path-refused" });
    expect(snapshot.items[3]!.diagnosis).toBeUndefined();
    expect(snapshot.causes).toEqual([expect.objectContaining({ cause: "path-refused", count: 2 }), expect.objectContaining({ cause: "no-result", count: 1 })]);
    await expect(w.brain.executeQuery(w.owner, { queryType: "tools.calls", workspaceId: w.workspaceId, resourceId: "x; drop" } as never)).rejects.toThrow(/resourceId/);
  });
});
