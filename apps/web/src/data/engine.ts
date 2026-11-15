import type { Delegation, WorkItem } from "@brain/contracts";
import { governor, query } from "./client";
import { bridgeQuery, type Loaded } from "./governor";

/**
 * Reads of the engine settings an owner makes (way of working, hosted model, drain, effect allow-list, runner groups,
 * single sign-on), the practices a team follows, the lessons Brain keeps and the Quality breakdown. The contract types
 * these snapshots as plain JSON, so the shapes the Governor returns are written down here once.
 */
type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

async function read<T>(request: Parameters<typeof query>[0], signal?: AbortSignal): Promise<Loaded<T>> {
  const response = await query<Envelope<T>>(request, signal);
  return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}

export type FailureClass = NonNullable<WorkItem["failureClass"]>;
export type Remedy = NonNullable<WorkItem["remedy"]>;

export type CostTier = "low" | "standard" | "premium";
export interface ModelRouteRow {
  routeId: string; enabled: boolean; vendor: string; keyRef: string; model: string; baseUrl: string; costTier: CostTier;
  inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number; position: number; usable: boolean;
  status: "off" | "down" | "up" | "unknown" | "quota"; quotaUntil?: string;
}

export interface EngineSettings {
  workspaceId: string;
  wayOfWorking?: { workflowId: string; requiredTools: string[] };
  workflows: { workflowId: string; tools: string[] }[];
  /** The workspace's model routes in the order they are tried (ADR 0055); a key is only ever named by reference. */
  modelRoutes: ModelRouteRow[];
  modelRouteRoles: string[];
  drain: { draining: boolean; runningAttempts: number; queuedJobs: number; since?: string };
  queueLimit: { maxQueued: number; queued: number; isDefault: boolean };
  autonomyCeiling: { preset: "supervised" | "standard" | "autonomous"; isDefault: boolean };
  /** What "stop all sessions" would stop right now (running sessions, the missions that would pause, waiting work). */
  liveWork: { sessions: number; standalone: number; waiting: number; missions: { missionId: string; title: string; sessions: number }[]; moreMissions: number };
}
export const engineSettingsRead = (workspaceId: string, signal?: AbortSignal) => read<EngineSettings>({ queryType: "engineSettings.get", workspaceId }, signal);

export interface EffectSettings { workspaceId: string; containers: string[]; services: string[]; approvalMinutes: number; egressHosts: string[]; runnerGroups: { groupId: string; hostTools: boolean }[] }
export const effectSettingsRead = (workspaceId: string, signal?: AbortSignal) => read<EffectSettings>({ queryType: "effects.get", workspaceId }, signal);

export interface RunnerGroupRow { groupId: string; hostTools: boolean; workspaceIds: string[] }
export const runnerGroupsRead = (signal?: AbortSignal) => read<{ items: RunnerGroupRow[] }>({ queryType: "runnerGroups.list" }, signal);

export type OidcRole = "viewer" | "operator" | "workspace-lead" | "approver";
export const OIDC_ROLES: readonly OidcRole[] = ["viewer", "operator", "workspace-lead", "approver"];
export interface OidcSettings {
  configured: boolean; enabled: boolean; redirectUri: string;
  issuer?: string; clientId?: string; secretRef?: string; secretReadable?: boolean; autoProvision?: boolean; defaultRole?: OidcRole; groupClaim?: string;
  groupRoles?: { group: string; role: OidcRole }[]; workspaceIds?: string[]; allowedDomains?: string[]; updatedBy?: string; updatedAt?: string;
}
export const oidcSettingsRead = (signal?: AbortSignal) => read<OidcSettings>({ queryType: "identity.oidc.get" }, signal);

export interface Lesson { lessonId: string; failureClass: FailureClass; outcome: "healed" | "parked"; taskTitle: string; lesson: string; createdAt: string; expiresAt: string }
export const lessonsRead = (workspaceId: string, signal?: AbortSignal) => read<{ items: Lesson[] }>({ queryType: "lessons.list", workspaceId, limit: 50 }, signal);

export interface Practice { id: string; title: string; description: string; plays: string[]; proposals: { proposalId: string; state: "proposed" | "approved" | "rejected"; playId: string }[]; canPropose: boolean }
export interface PracticesView { minMissions: number; eligibleMissions: number; practices: Practice[] }
export const practicesRead = (workspaceId: string, signal?: AbortSignal) => read<PracticesView>({ queryType: "practices.list", workspaceId }, signal);

export interface GuideStep { id: string; title: string; state: "done" | "todo" | "failed"; advice: string }
export interface GitGuide { connectionId?: string; ready: boolean; steps: GuideStep[] }
export const gitGuideRead = (connectionId: string | undefined, signal?: AbortSignal) => read<GitGuide>({ queryType: "integrations.guide", ...(connectionId ? { resourceId: connectionId } : {}) }, signal);

export interface BreakdownFigures { verified: number; verifiedUnaided: number; parkedOpen: number; stalled: number; activeTasks: number; missionsAchieved: number; missionsOpen: number; spendMicroUsd: number }
export interface BreakdownRow { figures: BreakdownFigures; rates: { verifiedUnaided?: number; stall?: number }; daily: { day: string; verified: number; parked: number }[] }
export interface QualityBreakdown {
  window: { from: string; to: string; days: number };
  definition: string;
  total: BreakdownRow;
  workspaces: (BreakdownRow & { workspaceId: string; name: string; practice: string })[];
  practices: (BreakdownRow & { practice: string; workspaces: number })[];
}
export const qualityBreakdownRead = (signal?: AbortSignal) => read<QualityBreakdown>({ queryType: "quality.breakdown" }, signal);

/** One saved regression case (`brain.eval-case/v1`, ADR 0010): the stored plan, the reviewer's findings and the pinned deliverable digests. */
export interface EvalCaseRow {
  format: "brain.eval-case/v1"; caseId: string; kind: "rejected-verdict" | "task-sent-back"; workspaceId: string; missionId: string; missionTitle: string; intent: string;
  successCriteria: string[]; tasks: { id: string; title: string; criteria: string[] }[]; findings: string[]; deliverableDigests: string[]; recordedAt: string;
}
/** Newest first; `total` counts every case even when `items` is the newest page of them. */
export const evalCasesRead = (workspaceId: string, signal?: AbortSignal) => read<{ items: EvalCaseRow[]; total: number }>({ queryType: "evalCases.list", workspaceId, limit: 100 }, signal);

/** The delegations of one mission (ADR 0053), newest first: each child session with how its own run stands and what a review decides on. */
export const delegationsRead = (workspaceId: string, missionId: string, signal?: AbortSignal) => read<{ items: Delegation[] }>({ queryType: "delegations.list", workspaceId, resourceId: missionId, limit: 100 }, signal);

/** Which sign-in ways the sign-in page offers (public, no session needed). */
export interface AuthProviders { password: boolean; sso: { providerId: string; label: string; startPath: string } | null }
export const authProvidersRead = (signal?: AbortSignal) => governor<AuthProviders>("/v1/auth/providers", undefined, signal);

/** A tool's own test, started on demand; the result is read back from the tool's test list. */
export const startToolSelfTest = (toolId: string, workspaceId: string) => governor<{ testId: string; runId: string }>(`/v1/config/tools/${encodeURIComponent(toolId)}/selftest`, { workspaceId });

/** A test email to the signed-in person (Health's email service is judged by it). */
export const sendTestEmail = () => governor<{ sent: boolean; reason: string }>("/v1/notification-preferences/email-test", {});

/** The workspaces a person can name in a setting (each once, whatever roles they hold in it). */
export async function workspaceChoices(signal?: AbortSignal): Promise<Loaded<{ workspaceId: string; displayName: string }[]>> {
  const loaded = await bridgeQuery({}, signal);
  const seen = new Map<string, { workspaceId: string; displayName: string }>();
  for (const entry of loaded.snapshot.items) if (!seen.has(entry.workspaceId)) seen.set(entry.workspaceId, { workspaceId: entry.workspaceId, displayName: entry.displayName });
  return { ...loaded, snapshot: [...seen.values()] };
}
