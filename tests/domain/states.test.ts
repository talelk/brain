import { describe, expect, it } from "vitest";
import { STATE_MACHINES, canTransition, isTerminal } from "@brain/contracts";
import { assertTransition, assertExpectedVersion } from "../../apps/governor/src/domain/states";
import { evaluateRunner, fits, available, type RunnerView } from "../../apps/governor/src/domain/placement";
import { compileWorkflowGraph, compileRelease, parseRestrictedYaml } from "../../apps/governor/src/modules/configuration/index";
import { goldenDocs } from "../helpers";
import type { Workflow } from "@brain/contracts";

describe("domain states (T03)", () => {
  it("covers every machine edge and forbids terminal reversal", () => {
    for (const [machine, transitions] of Object.entries(STATE_MACHINES.machines)) {
      for (const [from, targets] of Object.entries(transitions)) {
        for (const to of targets) expect(canTransition(machine, from, to)).toBe(true);
        if (targets.length === 0) {
          expect(isTerminal(machine, from)).toBe(true);
          expect(() => assertTransition(machine, from, "queued")).toThrow();
        }
      }
    }
    expect(() => assertTransition("job", "succeeded", "running")).toThrow();
    expect(() => assertExpectedVersion(3, 2)).toThrow();
    assertExpectedVersion(3, 3);
  });

  it("placement denies expired/unverified capabilities distinctly (E034/E035)", () => {
    const demand = { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 };
    const base: RunnerView = {
      id: "r1", groupId: "fixture-tools", adminState: "enabled", health: "healthy", online: true,
      capabilities: new Map([["os:linux", { verified: true, expiresAtMs: 9999999999999 }]]),
      capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 },
      reserved: { cpuMillicores: 0, memoryMb: 0, diskMb: 0, slots: 0 },
      reserve: { cpuMillicores: 500, memoryMb: 1024, diskMb: 0, slots: 0 },
      isolation: "ephemeral-container", engines: [],
    };
    const placement = { group: "fixture-tools", all: ["os:linux", "tool:bash"], resources: demand, isolation: "ephemeral-container" as const };
    const missing = evaluateRunner(placement, demand, base, 1000);
    expect(missing.eligible).toBe(false);
    expect(missing.reasons).toContain("missing-capability:tool:bash");
    const tight: RunnerView = { ...base, capacity: { cpuMillicores: 600, memoryMb: 1100, diskMb: 300, slots: 1 }, capabilities: new Map([...base.capabilities, ["tool:bash", { verified: true, expiresAtMs: 9999999999999 }]]) };
    expect(fits(demand, available(tight))).toBe(false);
  });

  it("compiles the golden workflow and rejects old grammars/cycles (E016/E020)", () => {
    const release = compileRelease(goldenDocs(), "rev-1");
    expect(release.workflows["fixture-workflow"]).toBeDefined();
    const wf = release.workflows["fixture-workflow"] as Workflow;
    expect(compileWorkflowGraph(wf, "golden")).toEqual(["echo", "verify"]);
    expect(() => parseRestrictedYaml("a: 1\na: 2\n", "dup.yaml")).toThrow();
    const cyclic = structuredClone(wf) as unknown as Workflow;
    (cyclic.spec.jobs["echo"] as unknown as { needs: string[] }).needs = ["verify"];
    expect(() => compileWorkflowGraph(cyclic, "cyclic")).toThrow(/cycle/);
  });
});
