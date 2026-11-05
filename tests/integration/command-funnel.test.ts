import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorContext } from "@brain/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandFunnel, type Command, type CommandHandler, type CommandHandlers } from "../../apps/governor/src/application/command-funnel";
import { Store } from "../../apps/governor/src/application/store";
import { setupWorld } from "../helpers";

/**
 * The command funnel's own contract (ADR 0002), exercised with fake handlers
 * over a real Store: a receipt exists only for an applied command intent, and
 * a retry of a still-pending intent follows the handler's declared kind.
 */

const ORG = "org-funnel";
const WS = "ws-funnel";
const actor: ActorContext = { kind: "human", actorId: "human-1", organizationId: ORG, scopes: [], authMethod: "session", authGeneration: 1 } as unknown as ActorContext;

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-funnel-"));
  store = new Store({ dataDir: dir });
  store.control.prepare("INSERT INTO organizations(id,auth_organization_id) VALUES (?,?)").run(ORG, ORG);
  store.control.prepare("INSERT INTO principals(id,organization_id,kind,auth_subject_id) VALUES (?,?,'human',?)").run(actor.actorId, ORG, actor.actorId);
  store.control.prepare("INSERT INTO workspaces(id,organization_id,slug,status) VALUES (?,?,?,'active')").run(WS, ORG, WS);
  store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'operator',1,?,?)").run(WS, ORG, actor.actorId, actor.actorId, store.now());
  store.workspaceDb(WS, ORG).exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
  store.control.exec("CREATE TABLE probe (id TEXT PRIMARY KEY)");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function command(type: string, key: string, payload: Record<string, unknown> = {}, workspaceId: string | null = WS): Command {
  return { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: type, idempotencyKey: key, payload, ...(workspaceId ? { workspaceId } : {}) } as unknown as Command;
}

/** A handler that counts its runs and can be told to fail. */
function probe(kind: "control" | "workspace" | "self") {
  const state = { runs: 0, fail: false };
  const handler: CommandHandler = {
    kind,
    handle: ({ cmd }) => {
      state.runs += 1;
      const db = kind === "control" ? store.control : store.workspaceDb(WS, ORG);
      db.prepare("INSERT INTO probe(id) VALUES (?)").run(`${cmd.commandId}-${state.runs}`);
      if (state.fail) throw new Error("effect failed");
      return { resourceId: `res-${cmd.commandId}` };
    },
  };
  return { state, handler };
}

const intent = (commandId: string) => (store.control.prepare("SELECT state FROM command_intents WHERE command_id=?").get(commandId) as { state: string } | undefined)?.state;
const receipts = (key: string) => (store.control.prepare("SELECT COUNT(*) AS n FROM command_idempotency WHERE idempotency_key=?").get(key) as { n: number }).n;
const probes = (db = store.workspaceDb(WS, ORG)) => (db.prepare("SELECT COUNT(*) AS n FROM probe").get() as { n: number }).n;

/** Simulates a crash after the effect committed but before the receipt did. */
function loseReceipt(key: string, commandId: string): void {
  store.control.prepare("DELETE FROM command_idempotency WHERE idempotency_key=?").run(key);
  store.control.prepare("UPDATE command_intents SET state='pending' WHERE command_id=?").run(commandId);
}

describe("command funnel", () => {
  it("retries a workspace command whose effect failed instead of replaying a phantom receipt", async () => {
    const { state, handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    state.fail = true;
    await expect(funnel.run(actor, command("test.ws", "fail-then-retry"))).rejects.toThrow(/effect failed/);
    expect(receipts("fail-then-retry")).toBe(0);
    expect(intent("cmd-fail-then-retry")).toBe("failed");
    expect(probes()).toBe(0);

    state.fail = false;
    const retried = await funnel.run(actor, command("test.ws", "fail-then-retry"));
    expect(retried.receipt).toMatchObject({ outcome: "applied", resourceId: "res-cmd-fail-then-retry" });
    expect(intent("cmd-fail-then-retry")).toBe("applied");
    expect(probes()).toBe(1);
  });

  it("replays a stored receipt without re-running the handler", async () => {
    const { state, handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    const first = await funnel.run(actor, command("test.ws", "replay"));
    const replay = await funnel.run(actor, command("test.ws", "replay"));
    expect(replay).toEqual(first);
    expect(state.runs).toBe(1);
  });

  it("rejects the same idempotency key reused with a different payload", async () => {
    const { handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    await funnel.run(actor, command("test.ws", "conflict", { title: "one" }));
    await expect(funnel.run(actor, command("test.ws", "conflict", { title: "two" }))).rejects.toThrow(/different payload/);
  });

  it("refuses an applied command id reused under another key", async () => {
    const { handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    await funnel.run(actor, command("test.ws", "id-a"));
    await expect(funnel.run(actor, { ...command("test.ws", "id-b"), commandId: "cmd-id-a" })).rejects.toThrow(/command id already recorded/);
  });

  it("recovers a crashed workspace command from its effect marker without re-running it", async () => {
    const { state, handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    const first = await funnel.run(actor, command("test.ws", "crash-ws"));
    loseReceipt("crash-ws", "cmd-crash-ws");

    const recovered = await funnel.run(actor, command("test.ws", "crash-ws"));
    expect(recovered.receipt).toEqual(first.receipt);
    expect(state.runs).toBe(1);
    expect(probes()).toBe(1);
    expect(intent("cmd-crash-ws")).toBe("applied");
  });

  it("commits a control command's effect, intent and receipt atomically", async () => {
    const { state, handler } = probe("control");
    const funnel = new CommandFunnel(store, [{ "test.control": handler }]);
    state.fail = true;
    await expect(funnel.run(actor, command("test.control", "ctl", {}, null))).rejects.toThrow(/effect failed/);
    expect(intent("cmd-ctl")).toBeUndefined();
    expect(receipts("ctl")).toBe(0);
    expect(probes(store.control)).toBe(0);
    state.fail = false;
    await funnel.run(actor, command("test.control", "ctl", {}, null));
    expect(intent("cmd-ctl")).toBe("applied");
    expect(probes(store.control)).toBe(1);
  });

  it("re-runs a self-managed handler for a pending intent", async () => {
    const { state, handler } = probe("self");
    const funnel = new CommandFunnel(store, [{ "test.self": handler }]);
    await funnel.run(actor, command("test.self", "crash-self"));
    loseReceipt("crash-self", "cmd-crash-self");
    await funnel.run(actor, command("test.self", "crash-self"));
    expect(state.runs).toBe(2);
    expect(receipts("crash-self")).toBe(1);
  });

  it("fails an external command with a pending intent as OUTCOME_UNKNOWN instead of re-running it", async () => {
    let runs = 0;
    let fail = false;
    const external: CommandHandler = { kind: "external", handle: async () => { runs += 1; if (fail) throw new Error("provider down"); return { resourceId: "ext-1" }; } };
    const funnel = new CommandFunnel(store, [{ "test.external": external }]);

    fail = true;
    await expect(funnel.run(actor, command("test.external", "ext-fail", {}, null))).rejects.toThrow(/provider down/);
    expect(intent("cmd-ext-fail")).toBe("failed");
    fail = false;
    await funnel.run(actor, command("test.external", "ext-fail", {}, null));
    expect(intent("cmd-ext-fail")).toBe("applied");

    loseReceipt("ext-fail", "cmd-ext-fail");
    await expect(funnel.run(actor, command("test.external", "ext-fail", {}, null))).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(runs).toBe(2);
  });

  it("projects after each commit, never on replay, and answers 202 only for queued work", async () => {
    let projected = 0;
    const handlers: CommandHandlers = {
      "test.queued": { kind: "workspace", handle: () => ({ outcome: "queued", resourceId: "run-1" }) },
    };
    const funnel = new CommandFunnel(store, [handlers], { afterCommit: () => { projected += 1; } });
    const first = await funnel.run(actor, command("test.queued", "queued"));
    expect(first.status).toBe(202);
    expect(first.receipt.outcome).toBe("queued");
    await funnel.run(actor, command("test.queued", "queued"));
    expect(projected).toBe(1);
  });

  it("refuses to compose two handlers for one command type", () => {
    const { handler } = probe("workspace");
    expect(() => new CommandFunnel(store, [{ "test.ws": handler }, { "test.ws": handler }])).toThrow(/more than one handler/);
  });

  it("requires a workspace for workspace handlers and refuses unknown commands before recording anything", async () => {
    const { handler } = probe("workspace");
    const funnel = new CommandFunnel(store, [{ "test.ws": handler }]);
    await expect(funnel.run(actor, command("test.ws", "no-ws", {}, null))).rejects.toThrow(/workspaceId required/);
    await expect(funnel.run(actor, command("definitely.not.a.command", "unknown"))).rejects.toThrow(/unknown command/);
    expect(intent("cmd-no-ws")).toBeUndefined();
    expect(intent("cmd-unknown")).toBeUndefined();
  });
});

describe("command funnel through Brain", () => {
  it("routes organization administration through the same funnel", async () => {
    const w = setupWorld();
    const before = w.brain.store.control.prepare("SELECT revocation_generation AS generation FROM organizations WHERE id=?").get(w.org) as { generation: number };
    const grant = {
      contractVersion: "brain.command/v1" as const, commandId: "cmd-funnel-org", commandType: "organization.member.role-grant",
      idempotencyKey: "funnel-org", expectedVersion: before.generation, payload: { principalId: "owner-1", role: "security-admin", reason: "Shared envelope" },
    };
    const accepted = await w.brain.executeCommand(w.owner, grant, "corr-1");
    expect(accepted.status).toBe(200);
    const replay = await w.brain.executeCommand(w.owner, grant, "corr-2");
    expect(replay.receipt).toEqual(accepted.receipt);
    const after = w.brain.store.control.prepare("SELECT revocation_generation AS generation FROM organizations WHERE id=?").get(w.org) as { generation: number };
    expect(after.generation).toBe(before.generation + 1);
    w.brain.close();
  });

  it("applies a workspace command once and answers 200 applied", async () => {
    const w = setupWorld();
    const cmd = {
      contractVersion: "brain.command/v1" as const, commandId: "cmd-funnel-objective", commandType: "objective.create",
      workspaceId: w.workspaceId, idempotencyKey: "funnel-objective", payload: { title: "Funnel", intent: "applied first", successCriteria: ["verified"] },
    };
    const first = await w.brain.executeCommand(w.owner, cmd, "corr-1");
    expect(first.status).toBe(200);
    expect(first.receipt.outcome).toBe("applied");
    const replay = await w.brain.executeCommand(w.owner, cmd, "corr-2");
    expect(replay).toEqual(first);
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM objectives").get()).toEqual({ n: 1 });
    w.brain.close();
  });

  it("recovers crashed self-managed workflow commands on retry", async () => {
    const w = setupWorld();
    const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key,
      ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
    }, key)).receipt;
    const crash = (key: string) => {
      w.brain.store.control.prepare("DELETE FROM command_idempotency WHERE idempotency_key=?").run(key);
      w.brain.store.control.prepare("UPDATE command_intents SET state='pending' WHERE command_id=?").run(`cmd-${key}`);
    };
    const objectiveId = (await run("objective.create", "self-objective", { title: "Recover", intent: "crash between effect and receipt", successCriteria: ["verified"] })).resourceId!;
    const planId = (await run("plan.propose", "self-plan", { objectiveId, origin: "manual", tasks: [{ id: "task", title: "Implement", criteria: ["verified"], dependsOn: [], workflowId: "fixture-workflow" }] })).resourceId!;
    await run("plan.confirm", "self-confirm", { planVersionId: planId }, 1);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const workItemId = (ws.prepare("SELECT id FROM work_items LIMIT 1").get() as { id: string }).id;
    const sessionId = (await run("session.create", "self-session", {
      workItemId, agentId: "agent", engineId: "pi", task: "Execute", budget: { maxTokens: 1000, maxMicroUsd: 500, maxTurns: 4 },
      scope: { allowedPaths: ["src"], prohibitedPaths: [], allowedTools: ["fixture.echo"] }, worktreeId: "wt",
    })).resourceId!;

    const dispatch = { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "Brain fixture" }, sessionId };
    const first = await run("workflow.dispatch", "self-dispatch", dispatch);
    crash("self-dispatch");
    const recovered = await run("workflow.dispatch", "self-dispatch", dispatch);
    expect(recovered).toEqual(first);
    expect(ws.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 1 });

    const cancelled = await run("workflow.cancel", "self-cancel", { runId: first.resourceId, reason: "Recovered" });
    crash("self-cancel");
    expect(await run("workflow.cancel", "self-cancel", { runId: first.resourceId, reason: "Recovered" })).toEqual(cancelled);
    expect(ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(first.resourceId)).toEqual({ state: "cancelled" });
    w.brain.close();
  });
});
