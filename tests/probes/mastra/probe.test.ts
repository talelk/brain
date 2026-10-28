import { describe, expect, it } from "vitest";

// G03 probe (load smoke): the pinned Mastra packages load and expose
// workflow/storage entry points. The product execution path is the Mastra
// WorkflowEnginePort, whose behavioral proofs are in
// tests/integration/mastra-conformance.test.ts. This test never claims G03 pass.
describe("G03 mastra probe (initial)", () => {
  it("loads @mastra/core workflows and @mastra/libsql storage", async () => {
    const workflows = (await import("@mastra/core/workflows")) as Record<string, unknown>;
    expect(typeof workflows["Workflow"]).toBe("function");
    const libsql = (await import("@mastra/libsql")) as Record<string, unknown>;
    expect(Object.keys(libsql).length).toBeGreaterThan(0);
    const core = (await import("@mastra/core")) as Record<string, unknown>;
    expect(typeof core["Mastra"]).toBe("function");
  });
});
