import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt } from "@brain/contracts";
import { DIGEST_A, setupWorld, type TestWorld } from "../helpers";

// Story 105 (ADR 0037): the workspace's egress allowlist is set by an administrator through one command, read back by one query, and
// reaches a runner only in the offer of a job of that workspace. State is reached through commands only.
async function run(w: TestWorld, actor: ActorContext, key: string, payload: Record<string, unknown>, workspaceId = w.workspaceId): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workspace.effects.set", workspaceId, idempotencyKey: key, payload,
  } as never, key)).receipt;
}
const effects = async (w: TestWorld, workspaceId = w.workspaceId) => ((await w.brain.executeQuery(w.owner, { queryType: "effects.get", workspaceId })) as unknown as { snapshot: { containers: string[]; egressHosts: string[]; approvalMinutes: number } }).snapshot;
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 4)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

async function dispatch(w: TestWorld, key: string, workspaceId: string): Promise<void> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: key } },
  } as never, key);
}

describe("workspace egress allowlist (story 105)", () => {
  it("an administrator sets it, reads it back normalized, and it is empty until then", async () => {
    const w = setupWorld();
    expect((await effects(w)).egressHosts).toEqual([]);
    const receipt = await run(w, w.owner, "egress-1", { egressHosts: ["API.Example.com", "models.internal:8000", "api.example.com", "10.0.0.7"] });
    expect(receipt.accepted).toBe(true);
    expect((await effects(w)).egressHosts).toEqual(["10.0.0.7", "api.example.com", "models.internal:8000"]);
    w.brain.close();
  });

  it("is replaced as a whole, kept when the command does not mention it, and cleared by an empty list", async () => {
    const w = setupWorld();
    await run(w, w.owner, "egress-keep-1", { egressHosts: ["a.example"], containers: ["web-1"] });
    await run(w, w.owner, "egress-keep-2", { approvalMinutes: 45 });
    expect(await effects(w)).toMatchObject({ egressHosts: ["a.example"], containers: ["web-1"], approvalMinutes: 45 });
    await run(w, w.owner, "egress-keep-3", { egressHosts: ["b.example"] });
    expect((await effects(w)).egressHosts).toEqual(["b.example"]);
    await run(w, w.owner, "egress-keep-4", { egressHosts: [] });
    expect((await effects(w)).egressHosts).toEqual([]);
    w.brain.close();
  });

  it("refuses an entry the proxy could not match, naming it", async () => {
    const w = setupWorld();
    for (const bad of ["https://api.example.com", "api.example.com/v1", "*.example.com", "api.example.com:0", "api.example.com:70000", "a..example", "-lead.example", "has space.example"]) {
      await fails(() => run(w, w.owner, `egress-bad-${bad}`, { egressHosts: [bad] }), /not a host the proxy can allow|payload|schema|pattern/iu);
    }
    expect((await effects(w)).egressHosts).toEqual([]);
    w.brain.close();
  });

  it("only an administrator may change it", async () => {
    const w = setupWorld();
    const operator = (await w.grantApprover("egress-operator")).actor;
    await fails(() => run(w, operator, "egress-operator", { egressHosts: ["api.example.com"] }), /forbidden|scope|not permitted|administration/iu);
    expect((await effects(w)).egressHosts).toEqual([]);
    w.brain.close();
  });

  it("belongs to one workspace: another workspace keeps its own list, and a runner is offered only its job's workspace's hosts", async () => {
    const w = setupWorld();
    const other = "ws-egress-other";
    w.brain.createWorkspace(w.owner, { workspaceId: other, slug: "egress-other" });
    await run(w, w.owner, "egress-a", { egressHosts: ["only-a.example"] });
    await run(w, w.owner, "egress-b", { egressHosts: ["only-b.example:8443"] }, other);
    expect((await effects(w)).egressHosts).toEqual(["only-a.example"]);
    expect((await effects(w, other)).egressHosts).toEqual(["only-b.example:8443"]);

    await dispatch(w, "egress-job-a", w.workspaceId);
    await dispatch(w, "egress-job-b", other);
    const runner = seedRunner(w, "runner-egress");
    const offers: Array<{ workspaceId: string; egressHosts: string[] }> = [];
    for (const request of ["req-egress-1", "req-egress-2"]) {
      const offer = w.brain.jobProtocol.claim(runner, request) as unknown as { workspaceId: string; egressHosts: string[] } | null;
      if (offer) offers.push(offer);
    }
    expect(offers.map((offer) => [offer.workspaceId, offer.egressHosts]).sort()).toEqual([[other, ["only-b.example:8443"]], [w.workspaceId, ["only-a.example"]]]);
    w.brain.close();
  });
});
