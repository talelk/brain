import { describe, expect, it } from "vitest";
import { compileRelease, compileWorkflowGraph, pointerGet, resolveBinding } from "../../apps/governor/src/modules/configuration/index";
import { goldenDocs } from "../helpers";
import type { Workflow } from "@brain/contracts";

// T10 packet acceptance: graph/binding/type checks fail compilation with
// named errors; a valid release compiles to a complete immutable IR whose
// digest changes iff any declared byte changes.
const REV = "sha256:" + "2".repeat(64);

function goldenWorkflow(): Workflow {
  return compileRelease(goldenDocs(), REV).workflows["fixture-workflow"]!;
}
function mutated(fn: (wf: Workflow) => void): Workflow {
  const wf = structuredClone(goldenWorkflow()) as Workflow;
  fn(wf);
  return wf;
}

describe("workflow compiler (T10)", () => {
  it("orders jobs topologically and rejects cycles, unknown needs and empty graphs", () => {
    expect(compileWorkflowGraph(goldenWorkflow(), "golden")).toEqual(["echo", "verify"]);
    expect(() => compileWorkflowGraph(mutated((wf) => {
      (wf.spec.jobs["echo"] as unknown as { needs: string[] }).needs = ["verify"];
    }), "cyclic")).toThrow(/cycle/);
    expect(() => compileWorkflowGraph(mutated((wf) => {
      (wf.spec.jobs["verify"] as unknown as { needs: string[] }).needs = ["ghost"];
    }), "unknown-need")).toThrow();
    expect(() => compileWorkflowGraph(mutated((wf) => {
      (wf.spec as unknown as { jobs: Record<string, unknown> }).jobs = {};
    }), "empty")).toThrow(/no jobs/);
  });

  it("bindings resolve literal/input/job pointers and fail on missing paths — never substitute", () => {
    const out = resolveBinding({
      a: { source: "literal", value: 7 },
      b: { source: "input", pointer: "/msg/text" },
      c: { source: "job", jobId: "echo", pointer: "/result" },
    }, { msg: { text: "hi" } }, { echo: { result: "ok" } });
    expect(out).toEqual({ a: 7, b: "hi", c: "ok" });
    expect(() => resolveBinding({ x: { source: "input", pointer: "/missing" } }, {}, {})).toThrow();
    expect(() => resolveBinding({ x: { source: "job", jobId: "ghost", pointer: "" } }, {}, {})).toThrow(/unavailable/);
    expect(() => resolveBinding({ x: { source: "env", pointer: "/HOME" } }, {}, {})).toThrow(/unknown source/);
    expect(pointerGet({ "a/b": { "~key": 3 } }, "/a~1b/~0key")).toBe(3);
  });

  it("release compilation is deterministic and rejects undeclared or mismatched documents", () => {
    const a = compileRelease(goldenDocs(), REV);
    const b = compileRelease(goldenDocs(), REV);
    expect(a.digest).toBe(b.digest);
    const tampered = goldenDocs().map((d) => d.path.endsWith("fixture.echo.yaml") ? { ...d, text: d.text.replace("run.sh", "evil.sh") } : d);
    // entrypoint is pinned to run.sh by the Tool schema; any digest drift or
    // outright rejection is acceptable — silent acceptance is not.
    let drift: string | undefined;
    try { drift = compileRelease(tampered, REV).digest; } catch { drift = "rejected"; }
    expect(drift).not.toBe(a.digest);
    expect(() => compileRelease([{ path: "x.yaml", text: "apiVersion: other/v1\nkind: Workflow\nmetadata:\n  id: w\n" }], REV)).toThrow(/apiVersion/);
    expect(() => compileRelease([{ path: "x.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Banana\nmetadata:\n  id: w\n" }], REV)).toThrow(/unsupported kind/);
    const dup = [...goldenDocs(), goldenDocs()[0]!];
    expect(() => compileRelease(dup, REV)).toThrow(/duplicate/);
  });
});

describe("UIConfig declaration checks (T09)", () => {
  const brainDoc = (ui: string) => goldenDocs().map((d) => d.path.endsWith("fixture-brain.yaml")
    ? { ...d, text: d.text.replace(/ui:[\s\S]*$/u, ui) }
    : d);
  it("rejects unknown foundations, missing ui and unavailable default locales", () => {
    expect(() => compileRelease(brainDoc("ui:\n    foundation: other\n    supportedLocales:\n    - en\n    defaultLocale: en\n"), REV)).toThrow(/foundation must be newui/);
    expect(() => compileRelease(brainDoc(""), REV)).toThrow(/spec\.ui required/);
    expect(() => compileRelease(brainDoc("ui:\n    foundation: newui\n    supportedLocales:\n    - fr\n    defaultLocale: en\n"), REV)).toThrow(/UI_DEFAULT_LOCALE_UNAVAILABLE/);
    const ok = compileRelease(goldenDocs(), REV);
    const manifest = ok.manifest as { ui: Record<string, unknown> | null };
    expect(manifest.ui?.["defaultLocale"]).toBe("en");
    expect(String(manifest.ui?.["foundationManifestDigest"])).toMatch(/^sha256:/u);
  });
});
