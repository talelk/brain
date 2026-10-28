import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// G03 durability probe: prove a Mastra workflow runs to completion against
// file-backed LibSQL storage. Full 100-wait/restart proof stays separate.
describe("G03 mastra durable run (probe)", () => {
  it("executes a two-step workflow with LibSQL storage", async () => {
    const { createWorkflow, createStep } = (await import("@mastra/core/workflows")) as typeof import("@mastra/core/workflows");
    const { Mastra } = (await import("@mastra/core")) as typeof import("@mastra/core");
    const { LibSQLStore } = (await import("@mastra/libsql")) as unknown as {
      LibSQLStore: new (opts: { id: string; url: string }) => unknown;
    };
    const dir = mkdtempSync(join(tmpdir(), "brain-mastra-"));
    const seen: string[] = [];
    const stepA = createStep({
      id: "echo",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ message: z.string() }),
      execute: async ({ inputData }: { inputData: { message: string } }) => {
        seen.push(`echo:${inputData.message}`);
        return { message: inputData.message };
      },
    } as never);
    const stepB = createStep({
      id: "verify",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ passed: z.boolean() }),
      execute: async ({ inputData }: { inputData: { message: string } }) => {
        seen.push(`verify:${inputData.message}`);
        return { passed: inputData.message === "Brain fixture" };
      },
    } as never);
    const workflow = createWorkflow({
      id: "fixture-probe",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ passed: z.boolean() }),
    } as never).then(stepA as never).then(stepB as never).commit();
    const mastra = new Mastra({
      workflows: { fixtureProbe: workflow as never },
      storage: new LibSQLStore({ id: "probe", url: `file:${join(dir, "mastra.db")}` }) as never,
    } as never);
    const wf = (mastra as unknown as { getWorkflow: (id: string) => unknown }).getWorkflow("fixtureProbe") as {
      createRun: () => Promise<{ start: (opts: { inputData: unknown }) => Promise<{ status: string; result?: unknown }> }>;
    };
    const run = await wf.createRun();
    const outcome = await run.start({ inputData: { message: "Brain fixture" } });
    expect(outcome.status).toBe("success");
    expect(seen).toEqual(["echo:Brain fixture", "verify:Brain fixture"]);
  }, 60_000);
});
