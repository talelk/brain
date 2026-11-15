import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { editedStarter } from "../support/starter";
import { missionWithTask } from "../support/pull-request-world";
import { stepUp } from "../helpers";
import { scaled } from "../support/timing";

// What the release's policy asks of the person who decides an approval (#147, ADR 0064): production changes are decided by a person, and
// with separationOfDuties the one who started the work, or owns its mission, never approves it. The refusal names the layer and field.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const POLICY = "config/operations-policy.yaml";
const open = async (bundle?: ReturnType<typeof editedStarter>) => {
  const world = await effectsWorld(bundle ? { bundle } : {});
  cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
  return world;
};
const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } };
const body = (approval: { subject_digest: string; version: number }, key: string, evidenceId?: string) => ({
  contractVersion: "brain.approval-decision/v1" as const, idempotencyKey: key, decision: "approve" as const, subjectDigest: approval.subject_digest,
  expectedVersion: approval.version, note: "ok", ...(evidenceId ? { stepUpEvidenceId: evidenceId } : {}),
});
/** The workspace owner, who started the work, as a person who may approve. */
async function ownerAsApprover(world: EffectsWorld) {
  world.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'owner-1', 'approver', 1, 'owner-1', ?)").run(world.w.workspaceId, world.w.org, world.store.now());
  return world.w.brain.resolveActor(new Headers({ authorization: `Bearer ${world.w.ownerToken}` }), world.w.workspaceId);
}

describe("separation of duties is enforced at approval", () => {
  it("refuses the person who started the work, naming the policy layer and field; another approver decides it", async () => {
    const world = await open();
    await world.dispatch("sod-1");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const identity = await ownerAsApprover(world);
    const why = await refusal(() => world.w.brain.decideApproval(identity, pending.id, body(pending, "sod-owner", "ev-any")));
    expect(why).toContain(`Policy ${POLICY} requires a different person to approve`);
    expect(why).toContain("(separationOfDuties)");
    // Nothing was decided: another approver still can.
    expect(world.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(pending.id)).toEqual({ state: "pending" });
    await world.decide(pending, "approve");
    await world.drain();
    expect(world.restarts()).toEqual(["restarted demo-app"]);
  }, scaled(180_000));

  it("refuses the owner of the mission the work serves, and the person who started the run", async () => {
    const world = await open();
    const { workItemId } = await missionWithTask(world);
    // The run is started by another person: the mission is still the owner's.
    const author = await world.w.grantApprover("author-2");
    await world.w.brain.executeCommand(author.actor, {
      contractVersion: "brain.command/v1", commandId: "cmd-sod-2", commandType: "workflow.dispatch", workspaceId: world.w.workspaceId, idempotencyKey: "sod-2",
      payload: { workflow: { id: "sre-task", digest: world.release.digest }, input: { situation: ["Restart the unhealthy container", "Acceptance criteria:", "1. Says what was checked", `FIXTURE_CALL_TOOL ${JSON.stringify({ id: "host.restart", input: { container: "demo-app" } })}`].join("\n") }, workItemId },
    } as never, "sod-2");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const missionOwner = await ownerAsApprover(world);
    expect(await refusal(() => world.w.brain.decideApproval(missionOwner, pending.id, body(pending, "sod-mission-owner", "ev-any")))).toContain("(separationOfDuties)");
    expect(await refusal(() => world.w.brain.decideApproval(author.identity, pending.id, body(pending, "sod-author", "ev-any")))).toContain("(separationOfDuties)");
  }, scaled(180_000));

  it("asks nothing more of the approver when no layer requires it: the refusal is then only the ordinary rules", async () => {
    const world = await open(editedStarter({ "operations-policy.yaml": (value) => { (value["spec"] as Record<string, unknown>)["separationOfDuties"] = false; } }));
    await world.dispatch("sod-off");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const identity = await ownerAsApprover(world);
    // The policy no longer refuses; the decision goes on to the step-up check, which this made-up evidence fails.
    const why = await refusal(() => world.w.brain.decideApproval(identity, pending.id, body(pending, "sod-off-owner", "ev-any")));
    expect(why).not.toContain("separationOfDuties");
    expect(why).toMatch(/step-up/u);
  }, scaled(180_000));
});

describe("production approval is by a person", () => {
  const production = () => editedStarter({ "host.restart.yaml": (value) => { (value["spec"] as Record<string, unknown>)["allowedEnvironments"] = ["production"]; } });

  it("refuses a machine principal deciding a change to production, naming the policy; a person decides it", async () => {
    const world = await open(production());
    await world.dispatch("prod-1");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    expect((JSON.parse(pending.subject_json) as { target: { environmentId: string } }).target.environmentId).toBe("production");
    const approver = await world.w.grantApprover("prod-approver");
    const machine = { ...approver.identity, actor: { ...approver.identity.actor, kind: "agent" as const } };
    const why = await refusal(() => world.w.brain.decideApproval(machine, pending.id, body(pending, "prod-machine")));
    expect(why).toContain(`Policy ${POLICY} requires a person to approve a change to the production environment production`);
    expect(why).toContain("(productionHumanApproval)");
    const evidence = await stepUp(world.w, approver, pending.id, pending.subject_digest);
    await world.w.brain.decideApproval(approver.identity, pending.id, body(pending, "prod-person", evidence));
    await world.drain();
    expect(world.restarts()).toEqual(["restarted demo-app"]);
  }, scaled(180_000));

  it("a change to another environment is not a production change: the same machine principal meets only the ordinary human-session rule", async () => {
    const world = await open();
    await world.dispatch("prod-local");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const approver = await world.w.grantApprover("local-approver");
    const machine = { ...approver.identity, actor: { ...approver.identity.actor, kind: "agent" as const } };
    const why = await refusal(() => world.w.brain.decideApproval(machine, pending.id, body(pending, "local-machine")));
    expect(why).not.toContain("productionHumanApproval");
    expect(why).toMatch(/human session/u);
  }, scaled(180_000));
});
