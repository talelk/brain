import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@brain/contracts";
import {
  compileRelease, compileWorkflowGraph, loadConfigDocsFromDir, mergePolicyFloor, resolveBinding,
} from "../../apps/governor/src/modules/configuration/index";
import { parseCron, nextCronFire, dueCronFires, cronFireId } from "../../apps/governor/src/modules/workflows/index";
import { BudgetTree } from "../../apps/governor/src/domain/budget";
import { nextCounter } from "../../apps/governor/src/domain/states";
import { computeSlaMinutes } from "../../apps/governor/src/modules/packs/index";
import { goldenDocs } from "../helpers";

function wf(jobs: Record<string, unknown>): Workflow {
  return {
    apiVersion: "brain.keyrus/v1", kind: "Workflow",
    metadata: { id: "t", version: "1.0.0" },
    spec: { inputSchemaRef: "s", outputSchemaRef: "s", jobs, outputs: {}, failFast: true, deadlineSeconds: 10 },
  } as unknown as Workflow;
}
const readJob = { kind: "dispatch", needs: [] as string[], input: {}, effectClass: "read" };
const writeJob = (needs: string[]) => ({ kind: "dispatch", needs, input: {}, effectClass: "write" });
const gateJob = (needs: string[]) => ({ kind: "gate", needs, input: {}, proposalFrom: "x" });

describe("config resolution and compiler bounds (T09)", () => {
  it("confined loader rejects traversal, absolute, case-collision and symlinks (E012)", () => {
    expect(() => compileRelease([{ path: "../escape.yaml", text: "kind: Pack\n" }], "r")).toThrow();
    expect(() => compileRelease([{ path: "/etc/passwd.yaml", text: "kind: Pack\n" }], "r")).toThrow();
    expect(() => compileRelease([
      { path: "Config.yaml", text: "kind: Pack\n" }, { path: "config.yaml", text: "kind: Pack\n" },
    ], "r")).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "brain-conf-"));
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    writeFileSync(join(outside, "secret.yaml"), "apiVersion: brain.keyrus/v1\nkind: Pack\nmetadata: {id: x}\nspec: {}\n");
    writeFileSync(join(dir, "a.yaml"), "apiVersion: brain.keyrus/v1\nkind: Pack\nmetadata: {id: a}\nspec: {}\n");
    expect(loadConfigDocsFromDir(dir)).toHaveLength(1);
    symlinkSync(join(outside, "secret.yaml"), join(dir, "link.yaml"));
    expect(() => loadConfigDocsFromDir(dir)).toThrow(/symlink/);
  });

  it("policy floor merges restrictively and rejects broadening/null-disable (E013)", () => {
    const floor = { productionHumanApproval: "required", defaultEffect: "deny", allowedOperations: ["a", "b", "c"], deniedOperations: [], maxMicroUsd: 100, maxRuntimeSeconds: 120, minimumIsolation: "ephemeral-container", separationOfDuties: true };
    const merged = mergePolicyFloor([
      { name: "floor", spec: floor },
      { name: "ws", spec: { allowedOperations: ["b", "c", "d"], deniedOperations: ["c"], maxMicroUsd: 999, maxRuntimeSeconds: 30, minimumIsolation: "process", separationOfDuties: false } },
    ]);
    expect(merged.effective.allowedOperations).toEqual(["b"]);
    expect(merged.effective.maxMicroUsd).toBe(100);
    expect(merged.effective.maxRuntimeSeconds).toBe(30);
    expect(merged.effective.minimumIsolation).toBe("ephemeral-container");
    expect(merged.effective.separationOfDuties).toBe(true);
    expect(() => mergePolicyFloor([{ name: "floor", spec: floor }, { name: "ws", spec: { productionHumanApproval: null as never } }])).toThrow(/null cannot disable/);
    expect(() => mergePolicyFloor([{ name: "floor", spec: floor }, { name: "ws", spec: { productionHumanApproval: "optional" } }])).toThrow(/cannot turn off/);
    const docs = goldenDocs();
    const broadened = [...docs, { path: "config/ws-policy.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Policy\nmetadata: {id: ws-policy}\nspec:\n  productionHumanApproval: optional\n" }];
    expect(() => compileRelease(broadened, "bad")).toThrow();
  });

  it("changing a tool document changes the release digest and document digest (E015)", () => {
    const a = compileRelease(goldenDocs(), "rev-1");
    const changed = goldenDocs().map((d) => d.path.includes("fixture.echo") ? { ...d, text: `${d.text}\n# mode change\n` } : d);
    const b = compileRelease(changed, "rev-1");
    expect(b.digest).not.toBe(a.digest);
    const da = a.documents.find((d) => d.id === "fixture.echo");
    const db = b.documents.find((d) => d.id === "fixture.echo");
    expect(da?.digest).not.toBe(db?.digest);
  });

  it("bindings to missing/future job outputs or fields reject, never empty-substitute (E017)", () => {
    expect(() => resolveBinding({ x: { source: "job", jobId: "future", pointer: "" } }, null, {})).toThrow(/unavailable/);
    expect(() => resolveBinding({ x: { source: "input", pointer: "/missing/deep" } }, { a: 1 }, {})).toThrow(/does not resolve/);
    expect(() => resolveBinding({ x: { source: "mystery" } }, null, {})).toThrow(/unknown source/);
    expect(resolveBinding({ x: { source: "literal", value: 3 } }, null, {})).toEqual({ x: 3 });
  });

  it("dangerous schema refs, network ids and catastrophic regex are rejected (E018)", () => {
    const withRef = goldenDocs().map((d) => d.path.includes("fixture-type")
      ? { ...d, text: `${d.text}\n  evil:\n    $ref: "https://attacker.example/schema.json"\n` } : d);
    expect(() => compileRelease(withRef, "bad")).toThrow(/external schema/);
    const withRegex = goldenDocs().map((d) => d.path.includes("fixture-type")
      ? { ...d, text: `${d.text}\n  evil:\n    pattern: "(a+)+$"\n` } : d);
    expect(() => compileRelease(withRegex, "bad")).toThrow(/regex/);
    const giant = [{ path: "config/big.yaml", text: `apiVersion: brain.keyrus/v1\nkind: Pack\nmetadata: {id: big}\nspec:\n  items: [${"1,".repeat(5000)}1]\n` }];
    expect(() => compileRelease(giant, "bad")).toThrow();
  });

  it("a gate on only one branch does not dominate the effect join (E019)", () => {
    const diamond = wf({
      start: { ...readJob },
      gate: gateJob(["start"]),
      sneaky: writeJob(["start", "gate"]),
    });
    expect(() => compileWorkflowGraph(diamond, "diamond")).toThrow(/no dominating gate/);
    const linear = wf({ start: { ...readJob }, gate: gateJob(["start"]), effect: writeJob(["gate"]) });
    expect(compileWorkflowGraph(linear, "linear")).toEqual(["start", "gate", "effect"]);
    const ungated = wf({ effect: writeJob([]) });
    expect(() => compileWorkflowGraph(ungated, "ungated")).toThrow(/no dominating gate/);
  });

  it("subgraph cycles, unknown refs and depth excess are rejected (E027)", () => {
    const docsFor = (n: number) => {
      const docs = [{ path: "config/brain.yaml", text: "apiVersion: brain.keyrus/v1\nkind: BrainConfig\nmetadata: {id: brain}\nspec:\n  ui: {foundation: newui, supportedLocales: [en], defaultLocale: en}\n" }];
      for (let i = 0; i < n; i++) {
        const next = i + 1 < n ? `w${i + 1}` : "w0";
        docs.push({
          path: `config/w${i}.yaml`,
          text: `apiVersion: brain.keyrus/v1\nkind: Workflow\nmetadata: {id: w${i}, version: 1.0.0}\nspec:\n  inputSchemaRef: s\n  outputSchemaRef: s\n  deadlineSeconds: 10\n  failFast: true\n  outputs: {}\n  jobs:\n    child:\n      kind: subgraph\n      needs: []\n      input: {}\n      outputSchemaRef: s\n      workflow: {id: ${next}, digest: "sha256:${"0".repeat(64)}"}\n`,
        });
      }
      return docs;
    };
    expect(() => compileRelease(docsFor(2), "cycle")).toThrow(/subgraph cycle/);
    expect(() => compileRelease(docsFor(7).map((d, i, all) => i === all.length - 1
      ? { ...d, text: d.text.replace("kind: subgraph", "kind: steer").replace(/workflow: \{[^}]*\}/, "message: done") }
      : d), "deep")).toThrow(/depth/);
  });

  it("cron DST policy: gap fires after gap, repeated hour fires once, ids unique (E030)", () => {
    const spec = parseCron("30 2 * * *");
    // 2026-03-29 Europe/Paris springs forward 02:00 -> 03:00; 02:30 does not exist.
    const fire = nextCronFire(spec, "Europe/Paris", Date.UTC(2026, 2, 28, 12, 0))!;
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(fire));
    expect(local).toBe("03:00");
    // 2026-10-25 falls back 03:00 -> 02:00; 02:30 occurs twice, fire once (first).
    const fall = nextCronFire(spec, "Europe/Paris", Date.UTC(2026, 9, 24, 12, 0))!;
    expect(fall).toBe(Date.UTC(2026, 9, 25, 0, 30)); // first 02:30 CEST = 00:30Z
    const after = nextCronFire(spec, "Europe/Paris", fall)!;
    expect(after).toBeGreaterThan(Date.UTC(2026, 9, 25, 23, 0)); // next day, not second 02:30
    expect(cronFireId("nightly", fall)).toBe(`nightly@${Math.floor(fall / 60000)}`);
    const hourly = parseCron("0 * * * *");
    const now = Date.UTC(2026, 0, 2, 12, 0);
    expect(dueCronFires(hourly, "UTC", Date.UTC(2026, 0, 1, 0, 0), now, "skip")).toEqual([]);
    expect(dueCronFires(hourly, "UTC", Date.UTC(2026, 0, 1, 0, 0), now, "once")).toEqual([now]);
    expect(() => parseCron("99 * * * *")).toThrow();
  });

  it("counter overflow stops allocation explicitly (E050)", () => {
    expect(nextCounter(41)).toBe(42);
    expect(() => nextCounter(Number.MAX_SAFE_INTEGER)).toThrow(/exhausted/);
    expect(() => nextCounter(-1)).toThrow();
    expect(() => nextCounter(1.5)).toThrow();
  });

  it("hierarchical budgets cannot oversubscribe across parent/children (E070)", () => {
    const tree = new BudgetTree();
    tree.createRoot("run", { microUsd: 1000, tokens: 10_000, turns: 10 });
    tree.reserve("run", "child-a", { microUsd: 600, tokens: 6000, turns: 6 });
    expect(() => tree.reserve("run", "child-b", { microUsd: 500, tokens: 1, turns: 1 })).toThrow(/BUDGET|exceeds/);
    expect(() => tree.reserve("child-a", "grandchild", { microUsd: 601, tokens: 1, turns: 1 })).toThrow();
    tree.reserve("run", "child-b", { microUsd: 400, tokens: 4000, turns: 4 });
    expect(tree.available("run")).toEqual({ microUsd: 0, tokens: 0, turns: 0 });
    tree.release("run", "child-b");
    tree.release("run", "child-b"); // exactly-once: second release after delete throws NOT_FOUND? child removed
  });

  it("SLA minutes: reopen sums, other responsibility pauses, DST uses absolute time (E084)", () => {
    const t0 = Date.UTC(2026, 2, 29, 0, 30); // 01:30 CET, spring-forward day in Paris
    const intervals = [
      { responsibility: "provider", startedAtMs: t0, endedAtMs: t0 + 60 * 60000 }, // wall clock jumps, elapsed 60m
      { responsibility: "customer", startedAtMs: t0 + 60 * 60000, endedAtMs: t0 + 120 * 60000 },
      { responsibility: "provider", startedAtMs: t0 + 120 * 60000, endedAtMs: null }, // reopened, open
    ];
    expect(computeSlaMinutes(intervals, "provider", t0 + 150 * 60000)).toBe(90);
    expect(computeSlaMinutes(intervals, "customer", t0 + 150 * 60000)).toBe(60);
    expect(computeSlaMinutes([], "provider", t0)).toBe(0);
  });
});
