import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { egressDouble, fakeMcpServer, listTools, mcpStarter, type FakeMcp } from "../support/mcp-world";
import { scaled } from "../support/timing";

/**
 * An external MCP effect tool (ADR 0064 on ADR 0024): the call is proposed, held, approved by a person for that exact call, and only then
 * made, once, by the pinned client in a sandbox granted only the server's host. Everything runs through the Governor, a real runner
 * supervisor and a real egress proxy; the MCP server is a local fake.
 */
let server: FakeMcp;
let net: Awaited<ReturnType<typeof egressDouble>>;
let world: EffectsWorld;
beforeAll(async () => {
  server = await fakeMcpServer();
  net = await egressDouble();
  const { bundle } = mcpStarter(server, { search: "read", create_note: "write" }, { listing: await listTools(server.url) });
  world = await effectsWorld({ bundle, egressHosts: [server.host], sandbox: (request, script, input) => net.run(request, script, input) });
}, scaled(60_000));
afterAll(async () => { await server.close(); await net.close(); if (world) { await world.app.close(); rmSync(world.root, { recursive: true, force: true }); } });

const notes = () => server.calls.filter((call) => call.name === "create_note");

describe("external MCP effect tools need an approval of that exact call", () => {
  it("runs a read tool at once, holds the write tool for approval, and makes no call to the server until a person approves", async () => {
    const w = world;
    await w.dispatch("mcp-hold", [{ id: "mcp.fake.search", input: { query: "notes" } }, { id: "mcp.fake.create-note", input: { title: "hello" } }]);
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    const subject = JSON.parse(approval.subject_json) as { operation: string; tool: { id: string; digest: string }; effectBounds: { summary: string; arguments: unknown } };
    expect(subject.operation).toBe("effect.mcp.fake.create-note");
    expect(subject.effectBounds.summary).toContain("create_note");
    expect(subject.effectBounds.summary).toContain(server.host);
    expect(subject.effectBounds.arguments).toEqual({ title: "hello" });
    // The read call ran (through the sandbox, to the declared host only); the write call did not: nothing reached the server, no permit exists.
    expect(server.calls.map((call) => call.name)).toEqual(["search"]);
    expect(notes()).toEqual([]);
    expect(w.permits()).toEqual([]);
    expect(w.sandboxRequests.filter((request) => request["network"] === "internal")).toEqual([expect.objectContaining({ profile: "agent", egressHosts: [server.host] })]);
    // Nobody can take a permit for it before the decision: not the attempt that proposed it.
    const call = w.calls()[0]!;
    expect(() => w.app.brain.issueEffectPermit(w.runner, w.attempts()[0]!.id, { proposalId: call.proposal_id, tool: subject.tool, input: { title: "hello" } })).toThrow();
    expect(w.permits()).toEqual([]);
    expect(await w.run()).toBe(false);
    expect(notes()).toEqual([]);

    // Declined: still nothing was sent.
    await w.decide(approval, "reject");
    await w.drain();
    expect(notes()).toEqual([]);
    expect(w.permits()).toEqual([]);
  }, scaled(120_000));

  it("makes the approved call once, to the declared host only, and records the permit as applied", async () => {
    const w = world;
    server.calls.length = 0;
    w.sandboxRequests.length = 0;
    await w.dispatch("mcp-approve", [{ id: "mcp.fake.create-note", input: { title: "approved note" } }]);
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    expect(notes()).toEqual([]);
    await w.decide(approval, "approve");
    await w.drain();
    expect(notes()).toEqual([{ name: "create_note", arguments: { title: "approved note" }, authorization: undefined }]);
    expect(w.permits()).toEqual([expect.objectContaining({ state: "applied", approval_id: approval.id })]);
    expect(w.calls().find((entry) => entry.approval_id === approval.id)).toMatchObject({ outcome: "applied", tool_id: "mcp.fake.create-note" });
    // The held call's sandbox: the internal network and exactly the server's host, nothing of the workspace's other hosts.
    const sandboxes = w.sandboxRequests.filter((request) => request["network"] === "internal");
    expect(sandboxes).not.toEqual([]);
    for (const request of sandboxes) expect(request).toMatchObject({ profile: "agent", egressHosts: [server.host] });
  }, scaled(120_000));
});
