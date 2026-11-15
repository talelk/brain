import type { JsonValue } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import type { MastraWorkflowEngine } from "../../apps/governor/src/modules/workflows/index";

/** Resolves when the Governor's workflow engine has no work in flight. */
export const settled = (brain: Brain): Promise<void> => (brain.workflows as MastraWorkflowEngine).settle();

/**
 * The starter's one-agent triage workflow, widened into three independent steps (`left`, `right`, `third`) and a
 * `join` that needs all three, for the tests of parallel steps (ADR 0043). It has no evaluation step, so a test
 * finishes each step through the engine port.
 */
export function parallelTriage(documents: ReadonlyArray<{ path: string; text: string }>): { path: string; text: string } {
  const source = documents.find((doc) => doc.path.endsWith("operations-triage.yaml"))!;
  const workflow = JSON.parse(source.text);
  const respond = workflow.spec.jobs["respond"];
  workflow.metadata.id = "triage-parallel";
  workflow.spec.jobs = { left: respond, right: respond, third: respond, join: { ...respond, needs: ["left", "right", "third"] } };
  workflow.spec.outputs = { response: { source: "job", jobId: "join", pointer: "" }, passed: { source: "literal", value: true } };
  return { path: "config/triage-parallel.yaml", text: JSON.stringify(workflow, null, 2) + "\n" };
}

/** A step output the starter's triage schema accepts. */
export const TRIAGE_OUTPUT = { summary: "Triaged", blockers: [], nextActions: [] } as unknown as JsonValue;
