import type {
  ApprovalRequest, AuditEntry, BoardView, ConfigExplanation, DeliveryDossier,
  DecisionHistoryEntry, IdentityView, IncidentDetail, IncidentSummary, JobSnapshot,
  JsonValue, MemberGrantView, MemoryQuery, PlacementExplanation, QueryRequest,
  QueryResponse, RunnerSnapshot, SessionView, SLASummary, TicketDetail, TicketSummary,
  TodayItem, ToolCatalogEntry, WorkspaceContext, WorkspaceSummary, HealthView,
  CommandReceipt,
} from "@brain/contracts";
import { command, governor, GovernorError, query } from "./client";

export { GovernorError, command, governor };

/** A query response plus the authority facts every screen must bind to. */
export interface Loaded<T> {
  readonly snapshot: T;
  readonly partialFailures?: readonly string[];
  /** Server clock the screen's freshness decisions use; never the browser clock. */
  readonly asOf: string;
  readonly sourceWatermark: number;
}

/**
 * Cache identity (document 21): organization, workspace, principal
 * authorization generation, query type and filters. A scope switch must not be
 * able to serve a row from another scope, so every key is checked here.
 */
export interface QueryKey {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly queryType: string;
  readonly filters?: Record<string, string | number | boolean | undefined>;
}

/** Typed access to one declared query kind with the server's own watermark. */
async function fetchView<K extends QueryRequest["queryType"], R extends QueryResponse & { queryType: K }>(
  request: Extract<QueryRequest, { queryType: K }>,
  signal?: AbortSignal,
): Promise<Loaded<R["snapshot"]>> {
  const response = await query<R>(request, signal);
  return { snapshot: response.snapshot as R["snapshot"], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}

export const todayQuery = (request: { workspaceId?: string; limit?: number; states?: string[] }, signal?: AbortSignal) =>
  fetchView({ queryType: "today", ...request }, signal);
export const bridgeQuery = (request: { workspaceId?: string } = {}, signal?: AbortSignal) =>
  fetchView({ queryType: "bridge", ...request }, signal);
export const workspaceContextQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "workspace.context", workspaceId }, signal);
export const jobsQuery = (request: { workspaceId?: string; states?: string[]; search?: string }, signal?: AbortSignal) =>
  fetchView({ queryType: "jobs.list", ...request }, signal);
export const jobQuery = (workspaceId: string, resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "job.get", workspaceId, resourceId }, signal);
export const jobExplainQuery = (workspaceId: string, resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "job.explain", workspaceId, resourceId }, signal);
export const runnersQuery = (request: { workspaceId?: string } = {}, signal?: AbortSignal) =>
  fetchView({ queryType: "runners.list", ...request }, signal);
export const runnerQuery = (resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "runner.get", resourceId }, signal);
export const sessionsQuery = (request: { workspaceId?: string } = {}, signal?: AbortSignal) =>
  fetchView({ queryType: "sessions.list", ...request }, signal);
export const sessionQuery = (workspaceId: string, resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "session.get", workspaceId, resourceId }, signal);
export const approvalsQuery = (request: { workspaceId?: string } = {}, signal?: AbortSignal) =>
  fetchView({ queryType: "approvals.list", ...request }, signal);
export const approvalQuery = (resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "approval.get", resourceId }, signal);
export const boardQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "board.get", workspaceId }, signal);
export const evidenceQuery = (resourceId: string, workspaceId?: string, signal?: AbortSignal) =>
  fetchView({ queryType: "evidence.get", resourceId, ...(workspaceId ? { workspaceId } : {}) }, signal);
export const memorySearchQuery = (workspaceId: string, memoryQuery: MemoryQuery, signal?: AbortSignal) =>
  fetchView({ queryType: "memory.search", workspaceId, memoryQuery }, signal);
export const slaQuery = (workspaceId: string, periodStart: string, periodEnd: string, signal?: AbortSignal) =>
  fetchView({ queryType: "sla.summary", workspaceId, periodStart, periodEnd }, signal);
export const configExplainQuery = (workspaceId: string, pointer: string, signal?: AbortSignal) =>
  fetchView({ queryType: "config.explain", workspaceId, pointer }, signal);
export const healthQuery = (signal?: AbortSignal) => fetchView({ queryType: "platform.health" }, signal);
export const ticketsQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "tickets.list", workspaceId }, signal);
export const ticketQuery = (workspaceId: string, resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "ticket.get", workspaceId, resourceId }, signal);
export const incidentsQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "incidents.list", workspaceId }, signal);
export const incidentQuery = (workspaceId: string, resourceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "incident.get", workspaceId, resourceId }, signal);
export function deliveryQuery(workspaceId: string, resourceId: string, signal?: AbortSignal): Promise<Loaded<DeliveryDossier>>;
export function deliveryQuery(workspaceId: string, resourceId: undefined, signal?: AbortSignal): Promise<Loaded<{ items: readonly DeliveryDossier[] }>>;
export async function deliveryQuery(workspaceId: string, resourceId?: string, signal?: AbortSignal) {
  return resourceId
    ? fetchView({ queryType: "delivery.get", workspaceId, resourceId }, signal)
    : fetchView({ queryType: "delivery.list", workspaceId }, signal);
}
export const toolsQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "tools.list", workspaceId }, signal);
export const decisionsQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "decisions.list", workspaceId }, signal);
export const membersQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "members.list", workspaceId }, signal);
export const auditQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "audit.list", workspaceId }, signal);
export const commandStatusQuery = (commandId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "command.get", commandId }, signal);

export type {
  ApprovalRequest, AuditEntry, BoardView, ConfigExplanation, DeliveryDossier,
  DecisionHistoryEntry, HealthView, IncidentDetail, IncidentSummary, JobSnapshot,
  MemberGrantView, PlacementExplanation, RunnerSnapshot, SessionView, SLASummary,
  TicketDetail, TicketSummary, TodayItem, ToolCatalogEntry, WorkspaceContext,
  WorkspaceSummary,
};
export type { IdentityView, CommandReceipt, JsonValue };
export { identity, setupStatus };

async function identity(signal?: AbortSignal): Promise<IdentityView> {
  return governor<IdentityView>("/v1/identity", undefined, signal);
}
async function setupStatus(): Promise<{ setupRequired: boolean; initialized: boolean }> {
  return governor("/v1/setup/status");
}

/** The exact decision-status read used by approval recovery (never a re-POST). */
export async function decisionStatus(approvalId: string, idempotencyKey: string): Promise<string> {
  const result = await governor<{ status: string }>(`/v1/approvals/${approvalId}/decision-status`, { idempotencyKey });
  return result.status;
}

/** One authoritative command; the receipt's outcome is the confirmation. */
export async function runCommand<TEnv extends import("@brain/contracts").CommandEnvelope>(
  envelope: Omit<TEnv, "contractVersion" | "commandId" | "commandType" | "idempotencyKey"> & {
    commandType: TEnv["commandType"];
    commandId?: string;
    idempotencyKey?: string;
  },
): Promise<CommandReceipt> {
  const full = {
    contractVersion: "brain.command/v1",
    commandId: `web-${crypto.randomUUID()}`,
    idempotencyKey: `web-${crypto.randomUUID()}`,
    ...envelope,
  } as unknown as TEnv;
  return command<CommandReceipt>(full);
}

/** Step-up: the challenge is bound to the exact approval subject digest. */
export async function stepUpVerify(approvalId: string, subjectDigest: string, code: string): Promise<string> {
  const challenge = await governor<{ challengeId: string }>("/v1/step-up/challenges", { approvalId, subjectDigest });
  const evidence = await governor<{ evidenceId: string }>("/v1/step-up/verify", { challengeId: challenge.challengeId, code });
  return evidence.evidenceId;
}
