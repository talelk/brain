import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, PlayView } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { collectRelease } from "../../apps/cli/src/release";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const STARTER = ["checklist-runbook", "compare-options", "incident-triage", "research-and-write", "support-reply-draft", "weekly-status"];

async function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, payload } as never, key)).receipt;
}
const plays = async (w: TestWorld): Promise<PlayView[]> => ((await w.brain.executeQuery(w.owner, { queryType: "plays.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: PlayView[] } }).snapshot.items;
const summary = async (w: TestWorld) => ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: { plays: number; starterPlays: { total: number; installed: number; installable: number; blocked: Array<{ playId: string; reason: string }> } } }).snapshot;

/** An existing workspace: the starter release as it was before Plays shipped with it. */
function existingWorkspace(): TestWorld {
  const w = setupWorld();
  const bundle = fixtureStarter();
  const documents = bundle.documents.filter((doc) => !doc.path.startsWith("config/plays/"));
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  return w;
}

describe("starter Plays (row 49)", () => {
  it("a fresh install gets six Plays with the starter release, each with a goal, criteria and a full budget", async () => {
    world = setupWorld();
    const w = world;
    const bundle = fixtureStarter();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    const list = await plays(w);
    expect(list.map((play) => play.playId).sort()).toEqual(STARTER);
    for (const play of list) {
      const detail = ((await w.brain.executeQuery(w.owner, { queryType: "plays.get", workspaceId: w.workspaceId, resourceId: play.playId })) as unknown as { snapshot: { spec: { intent: string; successCriteria: string[]; budget: { memberCap: number; maxMicroUsd: number }; plan: { tasks: Array<{ criteria: string[] }> } } } }).snapshot.spec;
      expect(detail.intent.length).toBeGreaterThan(40);
      expect(detail.successCriteria.length).toBeGreaterThanOrEqual(3);
      expect(detail.budget).toMatchObject({ memberCap: 2, maxMicroUsd: 2_000_000 });
      expect(detail.plan.tasks.every((task) => task.criteria.length > 0)).toBe(true);
    }
    expect(await summary(w)).toMatchObject({ plays: 6, starterPlays: { total: 6, installed: 6, installable: 0, blocked: [] } });
  });

  it("the raw starter release, with its real engines, compiles with all six Plays (first launch stages exactly this)", async () => {
    world = setupWorld();
    const w = world;
    const bundle = collectRelease("examples/v1/starter-release");
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    expect((await plays(w)).map((play) => play.playId).sort()).toEqual(STARTER);
    expect(await summary(w)).toMatchObject({ starterPlays: { installed: 6, installable: 0 } });
  });

  it("Add starter Plays installs the missing ones on an existing workspace, once, and a mission starts from one", async () => {
    world = existingWorkspace();
    const w = world;
    expect(await plays(w)).toEqual([]);
    expect(await summary(w)).toMatchObject({ plays: 0, starterPlays: { total: 6, installed: 0, installable: 6 } });
    const before = w.brain.store.control.prepare("SELECT release_digest, version FROM active_config WHERE organization_id=?").get(w.org) as { release_digest: string; version: number };

    expect((await run(w, "plays.addStarter", "add-1", {})).accepted).toBe(true);
    expect((await plays(w)).map((play) => play.playId).sort()).toEqual(STARTER);
    expect(await summary(w)).toMatchObject({ plays: 6, starterPlays: { installed: 6, installable: 0 } });
    const after = w.brain.store.control.prepare("SELECT release_digest, version FROM active_config WHERE organization_id=?").get(w.org) as { release_digest: string; version: number };
    expect(after.release_digest).not.toBe(before.release_digest);

    // A second click adds nothing and does not stage another release.
    expect((await run(w, "plays.addStarter", "add-2", {})).accepted).toBe(true);
    expect(w.brain.store.control.prepare("SELECT release_digest, version FROM active_config WHERE organization_id=?").get(w.org)).toEqual(after);

    // A mission starts from a Play: its plan comes from the template and the typed sentence is the goal.
    const receipt = await run(w, "mission.create", "from-play", { title: "Compare CRMs", intent: "Compare three CRMs for a ten-person team", playId: "compare-options", autoStart: false });
    expect(receipt.accepted).toBe(true);
    const plan = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT tasks_json FROM plan_versions WHERE mission_id=?").get(receipt.resourceId) as { tasks_json: string };
    expect((JSON.parse(plan.tasks_json) as Array<{ id: string }>).map((task) => task.id)).toEqual(["options", "compare"]);
  });

  it("keeps a Play the owner already has, adding only the others", async () => {
    world = setupWorld();
    const w = world;
    const bundle = fixtureStarter();
    const edited = JSON.parse(bundle.documents.find((doc) => doc.path.endsWith("research-and-write.yaml"))!.text);
    edited.spec.title = "Our own research routine";
    const documents = bundle.documents.filter((doc) => !doc.path.startsWith("config/plays/"));
    documents.push({ path: "config/plays/research-and-write.yaml", text: JSON.stringify(edited, null, 2) });
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    expect(await summary(w)).toMatchObject({ starterPlays: { installed: 1, installable: 5 } });
    await run(w, "plays.addStarter", "keep-1", {});
    const list = await plays(w);
    expect(list.map((play) => play.playId).sort()).toEqual(STARTER);
    expect(list.find((play) => play.playId === "research-and-write")!.title).toBe("Our own research routine");
  });

  it("skips every Play whose agent is not in the release, says why, and stages nothing", async () => {
    world = setupWorld();
    const w = world;
    const before = w.brain.store.control.prepare("SELECT release_digest FROM active_config WHERE organization_id=?").get(w.org);
    const status = (await summary(w)).starterPlays;
    expect(status).toMatchObject({ total: 6, installed: 0, installable: 0 });
    expect(status.blocked).toHaveLength(6);
    expect(status.blocked[0]!.reason).toMatch(/task-worker is not in the active release/);
    expect((await run(w, "plays.addStarter", "none-1", {})).accepted).toBe(true);
    expect(w.brain.store.control.prepare("SELECT release_digest FROM active_config WHERE organization_id=?").get(w.org)).toEqual(before);
  });

  it("is refused for a person without configuration administration", async () => {
    world = existingWorkspace();
    const w = world;
    w.brain.ensurePrincipal(w.org, "viewer-9", "human");
    const stranger = w.actor("viewer-9", w.workspaceId);
    await expect(w.brain.executeCommand(stranger, { contractVersion: "brain.command/v1", commandId: "cmd-viewer", commandType: "plays.addStarter", workspaceId: w.workspaceId, idempotencyKey: "viewer", payload: {} } as never, "viewer")).rejects.toThrow();
    expect(await plays(w)).toEqual([]);
  });
});
