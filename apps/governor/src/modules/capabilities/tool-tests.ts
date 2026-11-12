import type { ActorContext, JsonValue, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { activeReleaseRecord, releaseRecord } from "../configuration/index";
import { requireConfigurationAdmin } from "../configuration/activation";
import { diagnoseToolFailure, type ToolDiagnosis } from "./tool-diagnosis";

export interface ToolTestPorts {
  startRun(input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; workflow: Workflow; configDigest: string; runInput: JsonValue; executionKey: string }): { runId: string };
}

export interface ToolTestView {
  testId: string; runId: string; toolId: string; releaseDigest: string; input: JsonValue; requestedAt: string;
  state: "running" | "succeeded" | "failed"; output?: JsonValue; error?: string; diagnosis?: ToolDiagnosis;
}

/** The id of the one-step workflow a test runs as: the tag that keeps test runs apart from real calls. */
export const toolTestWorkflowId = (toolId: string): string => `tool-test:${toolId}`;

/**
 * Try a read tool with an input a person typed. The tool runs exactly as it does for an agent (same runner, sandbox and pinned script)
 * as a single-step workflow of the chosen release, active or staged. Test runs are recorded in tool_test_runs, never in tool_calls,
 * so they never count towards a tool's usage or failure rate.
 */
export class ToolTests {
  constructor(private readonly store: Store, private readonly ports: ToolTestPorts) {}

  run(actor: ActorContext, workspaceId: string, toolId: string, input: JsonValue, releaseDigest?: string): { testId: string; runId: string } {
    requireWorkspaceRead(this.store, actor, workspaceId);
    requireConfigurationAdmin(this.store, actor);
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BrainDomainError("INVALID_ARGUMENT", "the test input must be a JSON object");
    const record = releaseDigest ? releaseRecord(this.store, actor.organizationId, releaseDigest) : activeReleaseRecord(this.store, actor.organizationId);
    if (!record) throw new BrainDomainError("NOT_FOUND", "release not found");
    const tool = (record.release.manifest.tools ?? []).find((entry) => entry.id === toolId);
    if (!tool) throw new BrainDomainError("NOT_FOUND", `tool ${toolId} is not in this release`);
    // A write or privileged tool needs an effect permit for the exact call: a test never has one, so it is refused here instead of failing later.
    if (tool.effectClass !== "read") throw new BrainDomainError("INVALID_ARGUMENT", `${toolId} is a ${tool.effectClass} tool; only read tools can be tested here`);
    const bindings: Record<string, { source: "input"; pointer: string }> = {};
    for (const key of Object.keys(input)) bindings[key] = { source: "input", pointer: `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}` };
    const workflow = {
      apiVersion: "brain.keyrus/v1", kind: "Workflow", metadata: { id: toolTestWorkflowId(toolId), version: "1.0.0" },
      spec: {
        inputSchemaRef: tool.inputSchemaRef, outputSchemaRef: "tool-test/output",
        jobs: {
          test: {
            kind: "dispatch", needs: [], input: bindings, outputSchemaRef: tool.outputSchemaRef, timeoutSeconds: 60,
            uses: { type: "tool", release: { id: tool.id, digest: tool.digest } },
            runsOn: { group: "agents", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 }, isolation: "ephemeral-container" },
            effectClass: "read",
          },
        },
        outputs: { result: { source: "job", jobId: "test", pointer: "" } }, failFast: true, deadlineSeconds: 120,
      },
    } as unknown as Workflow;
    const testId = this.store.id("tooltest");
    const { runId } = this.ports.startRun({
      organizationId: actor.organizationId, workspaceId, actorId: actor.actorId, workflowId: toolTestWorkflowId(toolId), workflow,
      configDigest: record.digest, runInput: input, executionKey: testId,
    });
    this.store.control.prepare("INSERT INTO tool_test_runs(id,organization_id,workspace_id,tool_id,release_digest,run_id,input_json,requested_by,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(testId, actor.organizationId, workspaceId, toolId, record.digest, runId, JSON.stringify(input), actor.actorId, this.store.now());
    return { testId, runId };
  }

  /** Whether a run is a test of exactly this tool at this digest: the one case where a job with no agent may use the Governor's read brokers. */
  isTestOf(organizationId: string, runId: string, toolId: string): boolean {
    return Boolean(this.store.control.prepare("SELECT 1 FROM tool_test_runs WHERE organization_id=? AND run_id=? AND tool_id=?").get(organizationId, runId, toolId));
  }

  list(actor: ActorContext, workspaceId: string, toolId: string, limit: number): ToolTestView[] {
    requireWorkspaceRead(this.store, actor, workspaceId);
    const rows = this.store.control.prepare("SELECT id,run_id,tool_id,release_digest,input_json,created_at_ms FROM tool_test_runs WHERE organization_id=? AND workspace_id=? AND tool_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT ?")
      .all(actor.organizationId, workspaceId, toolId, limit) as Array<{ id: string; run_id: string; tool_id: string; release_digest: string; input_json: string; created_at_ms: number }>;
    const db = this.store.workspaceDb(workspaceId, actor.organizationId);
    return rows.map((row) => {
      const run = db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(row.run_id) as { state: string } | undefined;
      const step = db.prepare("SELECT s.state, o.output_json FROM workflow_steps s LEFT JOIN step_outputs o ON o.run_id=s.run_id AND o.step_id=s.step_id WHERE s.run_id=? AND s.step_id='test'").get(row.run_id) as { state: string; output_json: string | null } | undefined;
      const output = step?.output_json ? (JSON.parse(step.output_json) as JsonValue) : undefined;
      const failedState = step?.state === "failed" || run?.state === "failed" || run?.state === "cancelled";
      const state: ToolTestView["state"] = step?.state === "succeeded" || step?.state === "completed" ? "succeeded" : failedState ? "failed" : "running";
      const error = state === "failed" ? (typeof (output as { error?: unknown } | undefined)?.error === "string" ? String((output as { error: string }).error) : "The test run ended without a result.") : undefined;
      return {
        testId: row.id, runId: row.run_id, toolId: row.tool_id, releaseDigest: row.release_digest, input: JSON.parse(row.input_json) as JsonValue, requestedAt: iso(row.created_at_ms),
        state, ...(state === "succeeded" && output !== undefined ? { output } : {}), ...(error ? { error, diagnosis: diagnoseToolFailure(error) } : {}),
      };
    });
  }
}
