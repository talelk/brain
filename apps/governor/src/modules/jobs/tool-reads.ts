import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { releaseRecord } from "../configuration/index";
import { assertAttemptLive, loadAttempt } from "./attempts";

/**
 * Governed read tools whose data lives in the Governor (documents, CSV artifacts, knowledge). A runner never reads these stores: for an
 * agent's tool call it asks here, with its attempt lease, and the Governor rechecks everything the tool may touch before answering.
 * The pinned tool script then only bounds and shapes the bytes it is handed. Every refusal is audited.
 */

export interface ToolReadPorts {
  /** A document id, or a context reference `artifact:sha256:...` stored with one of this workspace's context packs. */
  documentText(organizationId: string, workspaceId: string, documentId: string, maxChars: number): JsonValue;
  /** The CSV text of one verified artifact of the workspace. */
  csvArtifact(organizationId: string, workspaceId: string, artifactId: string): JsonValue;
  /** Ranked, bounded knowledge hits inside the mission's scope. */
  knowledgeSearch?(organizationId: string, workspaceId: string, scope: { missionId: string | undefined; workItemId: string | undefined }, input: { query: string; limit: number }): JsonValue;
}

/** Tools whose data the Governor supplies; web.fetch is fetched by the runner under its pinned host allowlist. */
export const GOVERNOR_READ_TOOLS = ["documents.read", "csv.query", "knowledge.search"] as const;

export interface ToolReadRequest { readonly tool: { readonly id: string; readonly digest: string }; readonly input: Readonly<Record<string, unknown>> }

const MAX_DOCUMENT_CHARS = 20_000;

export function brokerToolRead(s: Store, ports: ToolReadPorts, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, request: ToolReadRequest): JsonValue {
  const row = loadAttempt(s, attemptId);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("NOT_FOUND", "attempt not found");
  assertAttemptLive(s, runner, row);
  const organizationId = String(row["organization_id"]);
  const workspaceId = String(row["workspace_id"]);
  const refuse = (reason: string, code: "FORBIDDEN" | "INVALID_ARGUMENT" | "NOT_FOUND" = "FORBIDDEN"): never => {
    s.emit(s.control, {
      organizationId, workspaceId, aggregateType: "attempt", aggregateId: attemptId, eventType: "tool.read.refused",
      payload: { attemptId, toolId: request.tool.id, reason }, destinations: [`workspace:${workspaceId}`],
    });
    throw new BrainDomainError(code, reason);
  };
  if (!(GOVERNOR_READ_TOOLS as readonly string[]).includes(request.tool.id)) return refuse(`${request.tool.id} is not a Governor-brokered read tool`);
  // The attempt's own agent, from the release the job is pinned to, must list this exact tool digest.
  const payload = s.control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(String(row["job_id"])) as { payload_json: string } | undefined;
  const parsed = payload ? JSON.parse(payload.payload_json) as { step?: { uses?: { type?: string; release?: { id: string } } } } : undefined;
  const agentId = parsed?.step?.uses?.type === "agent" ? parsed.step.uses.release?.id : undefined;
  const configDigest = (s.control.prepare("SELECT config_digest FROM jobs WHERE id=?").get(String(row["job_id"])) as { config_digest: string }).config_digest;
  const release = releaseRecord(s, organizationId, configDigest)?.release;
  const agent = agentId ? release?.agents?.[agentId] : undefined;
  if (!agent || !agent.spec.tools.some((allowed) => allowed.id === request.tool.id && allowed.digest === request.tool.digest)) return refuse(`this attempt's agent does not allow ${request.tool.id} at that digest`);
  const declared = release?.manifest.tools?.find((tool) => tool.id === request.tool.id && tool.digest === request.tool.digest);
  if (!declared || declared.effectClass !== "read") return refuse(`${request.tool.id} is not a read-effect tool of the pinned release`);

  const input = request.input;
  if (request.tool.id === "documents.read") {
    const documentId = typeof input["documentId"] === "string" ? input["documentId"] : "";
    const maxChars = typeof input["maxChars"] === "number" && Number.isInteger(input["maxChars"]) ? Math.min(Math.max(1, input["maxChars"]), MAX_DOCUMENT_CHARS) : 8000;
    if (!documentId) return refuse("documentId is required", "INVALID_ARGUMENT");
    try { return ports.documentText(organizationId, workspaceId, documentId, maxChars); } catch (error) { return refuseFrom(refuse, error); }
  }
  if (request.tool.id === "csv.query") {
    const artifactId = typeof input["artifactId"] === "string" ? input["artifactId"] : "";
    if (!artifactId) return refuse("artifactId is required", "INVALID_ARGUMENT");
    try { return ports.csvArtifact(organizationId, workspaceId, artifactId); } catch (error) { return refuseFrom(refuse, error); }
  }
  if (!ports.knowledgeSearch) return refuse("knowledge search is not available");
  const query = typeof input["query"] === "string" ? input["query"].trim() : "";
  if (!query) return refuse("query is required", "INVALID_ARGUMENT");
  // The scope is the attempt's own workspace, derived here from the run, never from the request. An agent that names another workspace is refused.
  if (input["workspaceId"] !== undefined && input["workspaceId"] !== workspaceId) return refuse("knowledge.search is limited to the workspace of this mission; the requested workspace is outside it");
  const limit = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) ? Math.min(Math.max(1, input["limit"]), 10) : 5;
  const ws = s.workspaceDb(workspaceId, organizationId);
  const runId = String(row["workflow_run_id"]);
  const work = ws.prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(runId) as { mission_id: string; work_item_id: string } | undefined;
  const planning = work ? undefined : ws.prepare("SELECT mission_id FROM planning_requests WHERE run_id=?").get(runId) as { mission_id: string } | undefined;
  try { return ports.knowledgeSearch(organizationId, workspaceId, { missionId: work?.mission_id ?? planning?.mission_id, workItemId: work?.work_item_id }, { query, limit }); } catch (error) { return refuseFrom(refuse, error); }
}

function refuseFrom(refuse: (reason: string, code?: "FORBIDDEN" | "INVALID_ARGUMENT" | "NOT_FOUND") => never, error: unknown): never {
  if (error instanceof BrainDomainError) {
    const code = error.code === "NOT_FOUND" || error.code === "INVALID_ARGUMENT" ? error.code : "FORBIDDEN";
    return refuse(error.message, code);
  }
  throw error;
}

