import type { CommandReceipt, DeliveryDossier, IdentityView, MemoryQuery, OrganizationDirectorySnapshot, QueryRequest, QueryResponse } from "@brain/contracts";
import { command, governor, query } from "./client";

export { command };

export async function identity(signal?: AbortSignal): Promise<IdentityView> {
  return governor<IdentityView>("/v1/identity", undefined, signal);
}

/** A query response plus the authority facts every screen must bind to. */
export interface Loaded<T> {
  readonly snapshot: T;
  readonly partialFailures?: readonly string[];
  /** Server clock the screen's freshness decisions use; never the browser clock. */
  readonly asOf: string;
  readonly sourceWatermark: number;
  readonly cursor?: string;
  readonly totalEstimate?: number;
}

/** Typed access to one declared query kind with the server's own watermark. */
function withEstimate<T>(snapshot: T): { totalEstimate?: number } {
  if (snapshot !== null && typeof snapshot === "object" && "totalEstimate" in snapshot && typeof snapshot.totalEstimate === "number") return { totalEstimate: snapshot.totalEstimate };
  return {};
}

async function fetchView<K extends QueryRequest["queryType"], R extends QueryResponse & { queryType: K }>(
  request: Extract<QueryRequest, { queryType: K }>,
  signal?: AbortSignal,
): Promise<Loaded<R["snapshot"]>> {
  const response = await query<R>(request, signal);
  const snapshot = response.snapshot as R["snapshot"];
  return { snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark,
    cursor: response.cursor, ...withEstimate(snapshot) };
}

async function fetchOrganizationView(request: QueryRequest, signal?: AbortSignal): Promise<Loaded<OrganizationDirectorySnapshot>> {
  const response = await query<QueryResponse>(request, signal);
  if (!response.queryType.startsWith("organization.")) throw new Error("Unexpected organization query response");
  const snapshot = response.snapshot as OrganizationDirectorySnapshot;
  return { snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark,
    cursor: response.cursor, ...withEstimate(snapshot) };
}

export const todayQuery = (request: { workspaceId?: string; limit?: number; states?: string[] }, signal?: AbortSignal) =>
  fetchView({ queryType: "today", ...request }, signal);
export const bridgeQuery = (request: { workspaceId?: string } = {}, signal?: AbortSignal) =>
  fetchView({ queryType: "bridge", ...request }, signal);
export const workspaceContextQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "workspace.context", workspaceId }, signal);
export const jobsQuery = (request: { workspaceId?: string; states?: string[]; search?: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
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
export const organizationMembersQuery = (request: { search?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  fetchOrganizationView({ queryType: "organization.members.list", ...request }, signal);
export const organizationMemberQuery = (resourceId: string, signal?: AbortSignal) =>
  fetchOrganizationView({ queryType: "organization.member.get", resourceId }, signal);
export const organizationInvitationsQuery = (request: { search?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
  fetchOrganizationView({ queryType: "organization.invitations.list", ...request }, signal);
export const organizationAuthPolicyQuery = (signal?: AbortSignal) =>
  fetchOrganizationView({ queryType: "organization.auth-policy.get" }, signal);
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
