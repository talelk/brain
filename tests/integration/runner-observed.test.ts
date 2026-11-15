import { afterEach, describe, expect, it } from "vitest";
import { DIGEST_A, seedHuman, setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { observation, registerRunner, type HelloReport } from "../support/runnerHello";

const DIGEST_B = `sha256:${"b".repeat(64)}`;

// The Runners page shows what a runner reported or probed, and nothing else: no placeholder version, no all-zero digest, no observation time
// the Governor made up. Runners register through the runner protocol (enroll, challenge, signed hello); the facts are read back through the
// runner queries.

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.brain.close();
});

type Engine = { id: string; version?: string; adapterDigest: string; features: string[] };
type Observation = { capability: string; observedAt: string; source: string; verified: boolean; expiresAt: string };
type Snapshot = { runnerId: string; engines: Engine[]; capabilities: Observation[] };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const register = (w: World, runnerId: string, report: HelloReport) => registerRunner(w.brain, w.owner, runnerId, report);

async function runner(w: World, runnerId: string): Promise<Snapshot> {
  return ((await w.brain.executeQuery(w.owner, { queryType: "runner.get", resourceId: runnerId })) as unknown as { snapshot: Snapshot }).snapshot;
}

function world(): World {
  const w = setupWorld();
  worlds.push(w);
  const bundle = fixtureStarter();
  w.brain.activateRelease(
    w.owner,
    w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest,
  );
  return w;
}

describe("the runner summary states only what the runner reported or probed", () => {
  it("returns each engine exactly as the runner reported it, and a version only when the runner stated one", async () => {
    const w = world();
    register(w, "runner-engines", {
      engines: [
        { id: "pi", version: "1.4.0", adapterDigest: DIGEST_A, features: ["sessions", "steer"] },
        { id: "fixture", adapterDigest: DIGEST_B, features: ["sessions"] },
      ],
    });
    const snapshot = await runner(w, "runner-engines");
    expect(snapshot.engines).toEqual([
      { id: "pi", version: "1.4.0", adapterDigest: DIGEST_A, features: ["sessions", "steer"] },
      { id: "fixture", adapterDigest: DIGEST_B, features: ["sessions"] },
    ]);
    expect(Object.keys(snapshot.engines[1]!)).not.toContain("version");
    const listed = ((await w.brain.executeQuery(w.owner, { queryType: "runners.list" })) as unknown as { snapshot: { items: Snapshot[] } }).snapshot.items;
    expect(listed.find((entry) => entry.runnerId === "runner-engines")!.engines).toEqual(snapshot.engines);
  });

  it("lists a Codex engine the runner probed, with the trusted-local isolation it states for it", async () => {
    const w = world();
    register(w, "runner-codex", {
      engines: [{ id: "codex", version: "0.1.0", adapterDigest: DIGEST_A, features: ["sessions"] }],
      capabilities: [observation("engine:codex", minutesAgo(1)), observation("engine-isolation:codex:trusted-local", minutesAgo(1))],
    });
    const snapshot = await runner(w, "runner-codex");
    expect(snapshot.engines).toEqual([{ id: "codex", version: "0.1.0", adapterDigest: DIGEST_A, features: ["sessions"] }]);
    expect(snapshot.capabilities.map((entry) => entry.capability)).toContain("engine-isolation:codex:trusted-local");
    const listed = ((await w.brain.executeQuery(w.owner, { queryType: "runners.list" })) as unknown as { snapshot: { items: Snapshot[] } }).snapshot.items;
    expect(listed.find((entry) => entry.runnerId === "runner-codex")!.engines.map((engine) => engine.id)).toEqual(["codex"]);
  });

  it("shows no engine for a runner that reported none, and invents none for an engine capability it merely listed", async () => {
    const w = world();
    register(w, "runner-silent", { capabilities: [observation("os:linux", minutesAgo(1)), observation("engine:pi", minutesAgo(1))] });
    const snapshot = await runner(w, "runner-silent");
    expect(snapshot.engines).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("0".repeat(64));
  });

  it("refuses a placeholder digest instead of storing or showing it", () => {
    const w = world();
    expect(() =>
      register(w, "runner-zero", { engines: [{ id: "acp", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }] }),
    ).toThrow(/placeholder/);
  });

  it("returns the observation time the runner reported, never the time of the query", async () => {
    const w = world();
    const probed = minutesAgo(3);
    const probedEngine = minutesAgo(2);
    register(w, "runner-times", { capabilities: [observation("os:linux", probed), observation("engine:pi", probedEngine)] });
    const first = await runner(w, "runner-times");
    expect(first.capabilities.find((entry) => entry.capability === "os:linux")!.observedAt).toBe(probed);
    expect(first.capabilities.find((entry) => entry.capability === "engine:pi")!.observedAt).toBe(probedEngine);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runner(w, "runner-times")).capabilities.map((entry) => entry.observedAt).sort()).toEqual([probed, probedEngine].sort());
  });

  it("refuses an observation with no time or a time in the future", () => {
    const w = world();
    expect(() =>
      register(w, "runner-undated", { capabilities: [{ capability: "os:linux", source: "runner-probe", verified: true, expiresAt: later(300_000) }] }),
    ).toThrow(/observed/);
    expect(() => register(w, "runner-future", { capabilities: [observation("os:linux", later(3_600_000))] })).toThrow(/future/);
  });

  it("labels a runner's observation as a runner probe whatever the runner calls it, and an operator's trust grant as an attestation", async () => {
    const w = world();
    register(w, "runner-label", { capabilities: [observation("os:linux", minutesAgo(1), { source: "admin-attestation" })] });
    const operatorSession = seedHuman(w.brain, w.org, "sec-op");
    w.brain.store.control
      .prepare(
        "INSERT OR REPLACE INTO organization_authorizations(organization_id, principal_id, role, granted_by, granted_at_ms) VALUES (?, 'sec-op', 'security-admin', 'owner-1', ?)",
      )
      .run(w.org, w.brain.store.now());
    const operator = await w.brain.resolveActor(new Headers({ authorization: `Bearer ${operatorSession.token}` }));
    w.brain.verifyTrustDomain(operator, { runnerId: "runner-label", domain: "lab-host", reason: "attested by the platform team" });
    const bySource = Object.fromEntries((await runner(w, "runner-label")).capabilities.map((entry) => [entry.capability, entry.source]));
    expect(bySource).toEqual({ "os:linux": "runner-probe", "trust:domain:lab-host": "admin-attestation" });
  });

  it("follows the runner's heartbeat: engines and observation times as probed, and an engine that stops answering disappears", async () => {
    const w = world();
    const session = register(w, "runner-beat", { engines: [{ id: "pi", version: "1.4.0", adapterDigest: DIGEST_A, features: ["sessions"] }] });
    const probed = minutesAgo(0.5);
    const beat = (sequence: number, engines: Engine[]) =>
      w.brain.jobProtocol.heartbeat(
        { runnerId: session.runnerId, epoch: session.epoch },
        {
          runnerId: session.runnerId,
          runnerEpoch: session.epoch,
          sequence,
          health: "healthy",
          observedFree: { cpuMillicores: 1000, memoryMb: 1024, diskMb: 0, slots: 2 },
          activeAttemptIds: [],
          observedAt: later(0),
          capabilities: [observation("os:linux", probed)],
          engines,
        },
      );
    beat(1, [{ id: "pi", version: "1.5.0", adapterDigest: DIGEST_B, features: ["sessions", "steer"] }]);
    const updated = await runner(w, "runner-beat");
    expect(updated.engines).toEqual([{ id: "pi", version: "1.5.0", adapterDigest: DIGEST_B, features: ["sessions", "steer"] }]);
    expect(Date.parse(updated.capabilities.find((entry) => entry.capability === "os:linux")!.observedAt)).toBe(Date.parse(probed));
    beat(2, []);
    expect((await runner(w, "runner-beat")).engines).toEqual([]);
    expect(() => beat(3, [{ id: "pi", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }])).toThrow(/placeholder/);
  });
});
