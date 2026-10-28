import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// G03 suspend/resume proof: a Mastra run suspends at a gate step, persists in
// LibSQL, and resumes exactly once with the decision payload.
describe("G03 mastra suspend/resume (probe)", () => {
  it("suspends at gate, resumes with approval, completes once", async () => {
    const { createWorkflow, createStep } = (await import("@mastra/core/workflows")) as typeof import("@mastra/core/workflows");
    const { Mastra } = (await import("@mastra/core")) as typeof import("@mastra/core");
    const { LibSQLStore } = (await import("@mastra/libsql")) as unknown as { LibSQLStore: new (opts: { id: string; url: string }) => unknown };
    const dir = mkdtempSync(join(tmpdir(), "brain-mastra-suspend-"));
    const effects: string[] = [];

    const gate = createStep({
      id: "gate",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ approvalId: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: async ({ resumeData, suspend }: { resumeData?: { approved: boolean }; suspend: (data: { approvalId: string }) => Promise<never> }) => {
        if (!resumeData) return suspend({ approvalId: "apr-probe-1" });
        return { approved: resumeData.approved };
      },
    } as never);
    const act = createStep({
      id: "act",
      inputSchema: z.object({ approved: z.boolean() }),
      outputSchema: z.object({ done: z.boolean() }),
      execute: async ({ inputData }: { inputData: { approved: boolean } }) => {
        effects.push(`act:${inputData.approved}`);
        return { done: inputData.approved };
      },
    } as never);
    const workflow = createWorkflow({
      id: "gate-probe",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ done: z.boolean() }),
    } as never).then(gate as never).then(act as never).commit();

    const makeMastra = () => new Mastra({
      workflows: { gateProbe: workflow as never },
      storage: new LibSQLStore({ id: "suspend-probe", url: `file:${join(dir, "mastra.db")}` }) as never,
    } as never);

    const mastra = makeMastra();
    const wf = (mastra as unknown as { getWorkflow: (id: string) => unknown }).getWorkflow("gateProbe") as {
      createRun: (opts?: { runId?: string }) => Promise<{
        start: (opts: { inputData: unknown }) => Promise<{ status: string }>;
        resume: (opts: { step: string; resumeData: unknown }) => Promise<{ status: string }>;
      }>;
    };
    const run = await wf.createRun({ runId: "gate-run-1" });
    const started = await run.start({ inputData: { message: "Brain fixture" } });
    expect(started.status).toBe("suspended");
    expect(effects).toEqual([]);

    // Simulate restart: a fresh Mastra instance over the same LibSQL file resumes the run.
    const mastra2 = makeMastra();
    const wf2 = (mastra2 as unknown as { getWorkflow: (id: string) => unknown }).getWorkflow("gateProbe") as typeof wf;
    const run2 = await wf2.createRun({ runId: "gate-run-1" });
    const resumed = await run2.resume({ step: "gate", resumeData: { approved: true } });
    expect(resumed.status).toBe("success");
    expect(effects).toEqual(["act:true"]);
  }, 60_000);
});
