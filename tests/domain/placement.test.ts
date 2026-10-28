import { describe, expect, it } from "vitest";
import { evaluateRunner, rankRunners, type RunnerView } from "../../apps/governor/src/domain/placement";
import type { Placement, Resources } from "@brain/contracts";

// T16 packet acceptance: pure hard placement predicates. Every rejection is
// a named, redacted reason (capability names only — never digests/secrets),
// and ranking is deterministic.
const NOW = 1_800_000_000_000;
const demand: Resources = { cpuMillicores: 500, memoryMb: 512, diskMb: 1024, slots: 1 };
const zero: Resources = { cpuMillicores: 0, memoryMb: 0, diskMb: 0, slots: 0 };

function runner(over: Partial<RunnerView> = {}): RunnerView {
  return {
    id: "r-1", groupId: "fixture", adminState: "enabled", health: "healthy", online: true,
    capabilities: new Map([
      ["tool:bash", { verified: true, expiresAtMs: NOW + 60_000 }],
      ["tool:python3", { verified: true, expiresAtMs: NOW + 60_000 }],
    ]),
    capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 4 },
    reserved: zero, reserve: zero, isolation: "container", engines: ["pi"],
    ...over,
  };
}
const placement = { group: "fixture", isolation: "container", all: ["tool:bash"] } as unknown as Placement;

describe("placement hard predicates (T16)", () => {
  it("eligible runner passes with no reasons", () => {
    expect(evaluateRunner(placement, demand, runner(), NOW)).toEqual({ eligible: true, reasons: [] });
  });

  it("each hard predicate rejects with its named reason", () => {
    const cases: Array<[Partial<RunnerView>, string]> = [
      [{ adminState: "draining" }, "runner-admin-state:draining"],
      [{ adminState: "quarantined" }, "runner-admin-state:quarantined"],
      [{ online: false }, "runner-offline"],
      [{ health: "unhealthy" }, "runner-unhealthy"],
      [{ groupId: "other" }, "group-mismatch"],
      [{ isolation: "host" }, "isolation-mismatch"],
      [{ capabilities: new Map() }, "missing-capability:tool:bash"],
      [{ capabilities: new Map([["tool:bash", { verified: false, expiresAtMs: NOW + 1000 }]]) }, "unverified-capability:tool:bash"],
      [{ capabilities: new Map([["tool:bash", { verified: true, expiresAtMs: NOW - 1 }]]) }, "expired-capability:tool:bash"],
      [{ capacity: { cpuMillicores: 100, memoryMb: 8192, diskMb: 20480, slots: 4 } }, "insufficient-capacity"],
      [{ reserved: { cpuMillicores: 3800, memoryMb: 0, diskMb: 0, slots: 0 } }, "insufficient-capacity"],
      [{ engines: ["Muse"] }, "engine-mismatch"],
    ];
    const withEngine = { ...placement, engine: { anyOf: ["pi", "acp"] } } as unknown as Placement;
    for (const [over, reason] of cases) {
      const v = evaluateRunner(withEngine, demand, runner(over), NOW);
      expect(v.eligible, reason).toBe(false);
      expect(v.reasons).toContain(reason);
      // Reasons are redacted: stable codes and capability names only.
      for (const r of v.reasons) expect(r).not.toMatch(/sha256|token|secret|key/iu);
    }
  });

  it("anyOf capability and ranking are deterministic", () => {
    const anyPlacement = { group: "fixture", isolation: "container", all: [], anyOf: ["tool:python3", "tool:deno"] } as unknown as Placement;
    expect(evaluateRunner(anyPlacement, demand, runner(), NOW).eligible).toBe(true);
    expect(evaluateRunner(anyPlacement, demand, runner({ capabilities: new Map() }), NOW).reasons).toContain("no-anyof-capability");

    const big = runner({ id: "r-big", capacity: { cpuMillicores: 8000, memoryMb: 16384, diskMb: 20480, slots: 8 } });
    const small = runner({ id: "r-small" });
    expect([small, big].sort(rankRunners).map((r) => r.id)).toEqual(["r-big", "r-small"]);
    const a = runner({ id: "r-a" });
    const b = runner({ id: "r-b" });
    expect([b, a].sort(rankRunners).map((r) => r.id)).toEqual(["r-a", "r-b"]);
  });
});
