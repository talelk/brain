import { z } from "zod";
import type { AuditVerifyResult } from "./audit-chain";
import { isSlug, MAX_FILE_BYTES, PLATFORM_KINDS, type PlatformKind, type Language, type PackFile, type PlayFile, type Problem, type SnapshotManifest } from "./files";
import { PRIORITIES, type Priority } from "./limits";
import type { ApprovalState, AttemptEvent, AttemptFailure, AttemptKind, Digest, Effect, JsonValue, RunnerCapability, ToolOutcome } from "./protocol";

/**
 * The Governor's API (docs/architecture.md section 4): `POST /v1/command {type, input, idempotencyKey}` and `POST /v1/query {type, input}`.
 * A success answers `{output}`; a refusal answers `{error}` with the HTTP status of its code. Every entry that is not `public` or
 * `instance-admin` takes `workspaceId` and needs at least the named role there. Times are milliseconds since 1970; money is micro-USD.
 */

// --- roles and errors ---

export const ROLES = ["viewer", "member", "admin"] as const;
export type Role = (typeof ROLES)[number];
export type ApiRole = "public" | Role | "instance-admin";
/** True when `have` may do what `need` may do. */
export const roleAtLeast = (have: Role, need: Role): boolean => ROLES.indexOf(have) >= ROLES.indexOf(need);

export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LEASE_LOST: 409,
  INVALID_WORKSPACE: 422,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
/** `problems` names each thing to fix: a field of the input, or a file of the workspace folder. */
export interface ApiError { readonly code: ErrorCode; readonly message: string; readonly problems?: readonly Problem[] }
export type ApiResponse<O> = { readonly output: O } | { readonly error: ApiError };
export class BrainError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly problems?: readonly Problem[]) {
    super(message);
  }
}

// --- views ---

/** `sessionId` is the session this request came with (not a secret: the token is). */
export interface User { readonly id: string; readonly name: string; readonly email: string; readonly instanceAdmin: boolean; readonly sessionId: string }
export interface WorkspaceSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly status: "active" | "archived";
  readonly role: Role;
  readonly visibility: "private" | "public";
  /** The kind of platform workspace it is (only a platform administrator sees one); null for any other. */
  readonly platform: PlatformKind | null;
  /** True when the person is not a member and sees the workspace only because it is public (always `viewer`). */
  readonly viaPublic: boolean;
}
/** A workspace as its screens show it: the active snapshot holds its agents, tools, Plays, memory entries, projects and settings. */
/** A pack the workspace uses that has a newer release than the one it is pinned to (0: the shipped baseline). */
export interface PackUpdate { readonly pack: string; readonly pinned: number; readonly latest: number }
/** The last push of the workspace folder to its git remote; null when it has none or has not pushed yet. A failure's message holds no secret. */
export interface FolderPush { readonly ok: boolean; readonly atMs: number; readonly commit: string; readonly message: string }
export interface Workspace extends WorkspaceSummary { readonly snapshotDigest: Digest; readonly commit: string; readonly snapshot: SnapshotManifest; readonly updates: readonly PackUpdate[]; readonly folderPush: FolderPush | null }
export interface FileEntry {
  readonly path: string;
  readonly bytes: number;
  /** `workspace`, or the pack that supplies the file. */
  readonly source: string;
  /** For a workspace file: the pack whose file of the same path it replaces. */
  readonly replaces?: string;
  /** For a workspace file with history: the last commit that changed it. */
  readonly lastCommit?: { readonly message: string; readonly atMs: number };
}
/** A file's text, or `binary` and no content when it is not text. */
export interface FileContent extends FileEntry {
  readonly content: string;
  readonly binary: boolean;
}
export interface PackSummary {
  readonly name: string;
  readonly description: string;
  readonly translations: PackFile["translations"];
  readonly requires: readonly string[];
  readonly agents: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string; readonly effect: Effect }>;
  readonly plays: ReadonlyArray<{ readonly name: string; readonly title: string; readonly description: string; readonly translations: PlayFile["translations"] }>;
}
/** A pack as the platform workspace manages it. */
export interface PackInfo extends PackSummary {
  /** The last release of the pack, of the admin workspace; 0 when none. */
  readonly version: number;
  /** Present when the platform workspace holds a copy: whether it differs from its last release. */
  readonly working?: { readonly changed: boolean };
  readonly released: readonly number[];
  readonly usedBy: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly pin: number }>;
}
/** `active` is false for a deactivated person: their role stays and works again when they are reactivated. */
export interface Member { readonly userId: string; readonly name: string; readonly email: string; readonly role: Role; readonly active: boolean }
/** A group with a role in the workspace, and the people who get it through the group. */
export interface MemberGroup { readonly groupId: string; readonly name: string; readonly role: Role; readonly members: ReadonlyArray<{ readonly userId: string; readonly name: string; readonly email: string }> }

// Users (docs/model.md, Users, invitations and groups).
export const USER_STATES = ["active", "invited", "deactivated"] as const;
export type UserState = (typeof USER_STATES)[number];
/** What an invitation gives: the instance role, workspace roles and groups. */
export interface Grants { readonly instanceAdmin: boolean; readonly workspaces: ReadonlyArray<{ readonly workspaceId: string; readonly role: Role }>; readonly groups: readonly string[] }
/** One row of the people table. An invited row is an invitation: `id` is the invitation's, and `invitationId` says so. */
export interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: UserState;
  readonly instanceAdmin: boolean;
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The workspaces the person has a role in, directly or through a group. */
  readonly workspaces: number;
  readonly lastSignInAt: number | null;
  readonly createdAt: number;
  readonly invitationId?: string;
  readonly expiresAt?: number;
  readonly grants?: Grants;
}
export interface GroupRow {
  readonly id: string;
  readonly name: string;
  readonly members: ReadonlyArray<{ readonly userId: string; readonly name: string; readonly email: string }>;
  readonly grants: ReadonlyArray<{ readonly workspaceId: string; readonly name: string; readonly role: Role }>;
}
export interface SessionRow { readonly id: string; readonly createdAt: number; readonly expiresAt: number; readonly ipAddress: string | null; readonly userAgent: string | null; readonly current: boolean }
export interface SignInRow { readonly at: number; readonly ok: boolean; readonly ipAddress: string | null; readonly userAgent: string | null }
/** One workspace a person can reach: the role they have, and where it comes from. */
export interface AccessRow { readonly workspaceId: string; readonly slug: string; readonly name: string; readonly role: Role; readonly direct: Role | null; readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string; readonly role: Role }> }
export interface UserDetail {
  readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly status: Exclude<UserState, "invited">; readonly instanceAdmin: boolean; readonly createdAt: number; readonly lastSignInAt: number | null };
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly sessions: readonly SessionRow[];
  readonly signIns: readonly SignInRow[];
  readonly access: readonly AccessRow[];
}
/** What `user.invite` and `user.resetLink` answer: the one-use link, shown once. */
export interface LinkOutput { readonly link: string; readonly expiresAt: number }
export interface SecretName { readonly name: string; readonly updatedAt: number }

export const TASK_STATES = ["waiting", "ready", "running", "needs_you", "done", "failed", "stopped"] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Why a task needs a person, and what answers it. */
export type TaskNeed =
  | { readonly kind: "confirm-plan" }
  | { readonly kind: "approval"; readonly approvalId: string }
  | { readonly kind: "answer"; readonly question: string }
  | { readonly kind: "check"; readonly findings: string }
  | { readonly kind: "sign-off" }
  | { readonly kind: "judge"; readonly attemptIds: readonly string[] }
  | { readonly kind: "failed-subtask"; readonly taskId: string };
export interface TaskSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly title: string;
  /** The title of the goal this task belongs to (its own title for a goal). */
  readonly goalTitle: string;
  readonly agent: string | null;
  readonly state: TaskState;
  readonly needs: TaskNeed | null;
  readonly play: string | null;
  readonly stepId: string | null;
  readonly round: number;
  readonly microUsd: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  /** The name of the person who started the goal; absent for a goal a trigger started. */
  readonly createdByName?: string;
  /** How many tasks of this task's tree (itself included) wait for a person; a goal is shown as needing you when this is above zero. */
  readonly waitingForYou: number;
  /** For a task closed automatically because a newer identical one had a result: that task, its state, and when and after how many hours it was closed. */
  readonly supersededBy?: { readonly taskId: string; readonly rootId: string; readonly state: "done" | "check"; readonly hours: number; readonly at: number };
  /** For a heal task: the failed task it looks into. */
  readonly heals?: { readonly id: string; readonly rootId: string; readonly title: string };
}
/** A sub-task as the plan lists it: what it was asked and what it waits for. */
export interface SubtaskSummary extends TaskSummary { readonly goal: string; readonly waitsFor: readonly string[] }
export interface Usage { readonly microUsd: number; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number }
export type AttemptState = "queued" | "offered" | "running" | "succeeded" | "failed" | "held" | "stopped";
export interface Attempt {
  readonly id: string;
  readonly taskId: string;
  readonly kind: AttemptKind;
  readonly agent: string;
  readonly state: AttemptState;
  readonly round: number;
  readonly runner: string | null;
  readonly engine: string | null;
  readonly model: string | null;
  readonly result: string | null;
  readonly failure: AttemptFailure | null;
  readonly usage: Usage;
  /** False when the attempt used tokens nothing put a price on: its model has no prices in `brain.toml` and the model server reported no cost. */
  readonly priced: boolean;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}
export interface Check {
  readonly id: number;
  readonly taskId: string;
  readonly round: number;
  readonly by: { readonly kind: "agent" | "person"; readonly id: string; readonly name: string };
  readonly pass: boolean;
  readonly score: number | null;
  readonly findings: string;
  readonly at: number;
}
/** Exactly what an approver is shown and what their decision is bound to, through `subjectDigest`. */
export interface ApprovalSubject {
  readonly tool: string;
  readonly toolDigest: Digest;
  readonly input: JsonValue;
  readonly inputDigest: Digest;
  readonly taskId: string;
  readonly snapshotDigest: Digest;
  /** For a pull request: the digest of the patch that would be opened, and the commit of the project it is made on (absent: the branch head). */
  readonly patchDigest?: Digest;
  readonly baseCommit?: string;
}
export interface Approval {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  /** The goal the task belongs to. */
  readonly rootTaskId: string;
  readonly goalTitle: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly tool: string;
  readonly effect: Effect;
  readonly subject: ApprovalSubject;
  readonly subjectDigest: Digest;
  readonly state: ApprovalState;
  /** True when a standing approval of `brain.toml` covered the call. */
  readonly standing: boolean;
  readonly requestedAt: number;
  readonly expiresAt: number | null;
  readonly decidedBy: { readonly id: string; readonly name: string } | null;
  readonly decidedAt: number | null;
  readonly reason: string | null;
  readonly version: number;
}
export interface ToolCall {
  readonly id: string;
  readonly attemptId: string;
  readonly tool: string;
  readonly effect: Effect;
  readonly input: JsonValue;
  readonly output: JsonValue | null;
  readonly outcome: ToolOutcome | "pending";
  readonly approvalId: string | null;
  readonly at: number;
}
export interface Note { readonly id: number; readonly taskId: string; readonly author: string; readonly text: string; readonly at: number }
export interface ArtifactLink { readonly digest: Digest; readonly name: string; readonly kind: string; readonly mediaType: string; readonly bytes: number; readonly attemptId: string | null }
export interface PullRequest { readonly taskId: string; readonly project: string; readonly branch: string; readonly url: string; readonly number: number; readonly state: string; readonly at: number }
/** Everything the Task page shows. */
export interface Task extends TaskSummary {
  readonly goal: string;
  readonly result: string | null;
  readonly output: JsonValue | null;
  readonly snapshotDigest: Digest;
  readonly createdBy: string;
  readonly waitsFor: readonly string[];
  /** The task's priority and pause (its own, else its goal's), and for a task that is queued why it is not running: see `Wait`. */
  readonly steer: { readonly priority: Priority; readonly paused: boolean };
  readonly queued: { readonly taskId: string; readonly title: string; readonly wait: Wait; readonly rank: number | null; readonly startsAt: number | null } | null;
  readonly settings: { readonly reviewBy: string | null; readonly maxRounds: number; readonly targetScore: number | null; readonly approve: boolean; readonly when: string | null; readonly candidates: number | readonly string[] | null; readonly judge: string | null };
  readonly subtasks: readonly SubtaskSummary[];
  readonly attempts: readonly Attempt[];
  readonly checks: readonly Check[];
  readonly approvals: readonly Approval[];
  readonly toolCalls: readonly ToolCall[];
  readonly notes: readonly Note[];
  readonly artifacts: readonly ArtifactLink[];
  readonly pullRequests: readonly PullRequest[];
  readonly usage: Usage;
  /** For a failed task: the heal task that looks into it, once there is one. */
  readonly heal: { readonly taskId: string; readonly state: TaskState } | null;
  readonly version: number;
}
export interface Spend { readonly todayMicroUsd: number; readonly capMicroUsd: number }
export interface Today {
  readonly needsYou: readonly TaskSummary[];
  readonly running: readonly TaskSummary[];
  readonly recent: readonly TaskSummary[];
  readonly approvals: readonly Approval[];
  readonly spend: Spend;
}
export interface UsageSummary {
  readonly spend: Spend;
  readonly total: Usage;
  readonly byDay: ReadonlyArray<Usage & { readonly day: string }>;
  readonly byAgent: ReadonlyArray<Usage & { readonly agent: string }>;
  readonly byModel: ReadonlyArray<Usage & { readonly model: string }>;
}
/** Why a queued task is not running yet, in the order the Governor checks (docs/model.md, The queue). */
export type Wait =
  | { readonly kind: "slot"; readonly ahead: number }
  | { readonly kind: "running-tasks"; readonly used: number; readonly limit: number }
  | { readonly kind: "daily-cap"; readonly spentMicroUsd: number; readonly capMicroUsd: number }
  | { readonly kind: "capability"; readonly what: "agent" | "engine" | "capability"; readonly missing: string }
  | { readonly kind: "no-runner" }
  | { readonly kind: "task"; readonly taskId: string; readonly title: string }
  | { readonly kind: "paused-workspace" }
  | { readonly kind: "paused-task" }
  | { readonly kind: "backoff"; readonly until: number; readonly tries: number };
/** One task waiting to start. `rank` is its place in dispatch order (from 1); null for one that waits for another task or is held. */
export interface QueueItem {
  readonly taskId: string;
  readonly rootId: string;
  readonly title: string;
  readonly goalTitle: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly agent: string | null;
  readonly kind: AttemptKind;
  readonly priority: Priority;
  readonly paused: boolean;
  readonly rank: number | null;
  readonly since: number;
  readonly wait: Wait;
  /** When it will probably start, from the median duration of recent attempts of its kind; null when that cannot be known. */
  readonly startsAt: number | null;
  /** The caller may steer it (a member of its workspace). */
  readonly canSteer: boolean;
}
/** An attempt in a runner's slot. */
export interface QueueRun {
  readonly attemptId: string;
  readonly taskId: string;
  readonly rootId: string;
  readonly title: string;
  readonly goalTitle: string;
  readonly agent: string;
  readonly kind: AttemptKind;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly startedAt: number | null;
  readonly tokens: number;
  readonly microUsd: number;
}
export interface QueueRunner {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly slots: number;
  readonly freeSlots: number;
  /** Only for an instance admin; empty for anyone else. */
  readonly engines: readonly string[];
  readonly capabilities: readonly string[];
  readonly occupied: readonly QueueRun[];
  /** Slots held by a workspace the caller does not see. */
  readonly hiddenOccupied: number;
}
export interface Queue {
  readonly now: number;
  readonly runners: readonly QueueRunner[];
  /** Ready tasks in the order the Governor will start them, then those held (paused, backoff). Only workspaces the caller sees. */
  readonly waiting: readonly QueueItem[];
  /** Tasks that wait for another task, oldest first (at most 100). */
  readonly blocked: readonly QueueItem[];
  /** How many waiting tasks are in workspaces the caller does not see. */
  readonly hidden: number;
  readonly running: number;
  /** Workspaces whose queue is paused, among those the caller sees. */
  readonly paused: ReadonlyArray<{ readonly id: string; readonly slug: string; readonly name: string }>;
  readonly admin: boolean;
}
/** The windows Insights can look over, in days. */
export type InsightDays = 7 | 30 | 90;
/** One thing time or money went to, over the window. `msPerDay` and `microPerDay` have one entry per day of `Insights.days`. */
export interface InsightRank {
  readonly key: string;
  /** The name to show: a workspace's name, an agent, a Play's title; empty for goals typed in words (no Play). */
  readonly label: string;
  readonly attempts: number;
  /** Time attempts ran, in ms. */
  readonly ms: number;
  readonly microUsd: number;
  readonly tokens: number;
  readonly msPerDay: readonly number[];
  readonly microPerDay: readonly number[];
}
export interface InsightTool { readonly tool: string; readonly calls: number; readonly failed: number; readonly ms: number; readonly perDay: readonly number[] }
/** p50 and p90 by nearest rank (the value at place ceil(p x n) of the n sorted values), in ms. */
export interface InsightPercentiles { readonly key: string; readonly label: string; readonly n: number; readonly p50: number; readonly p90: number }
export type FailureBucket = "limits" | "setup" | "engine" | "checks" | "other";
export interface InsightFailure {
  readonly bucket: FailureBucket;
  readonly count: number;
  /** The five most recent. */
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly rootId: string; readonly title: string; readonly goalTitle: string; readonly workspaceSlug: string; readonly at: number }>;
}
/** What a person who steers asks of the past: see docs/model.md, "The timeline and Insights". Days are the caller's own (`tzOffsetMinutes`). */
export interface Insights {
  readonly now: number;
  /** Local days (`YYYY-MM-DD`), oldest first, the last one today. */
  readonly days: readonly string[];
  readonly totals: { readonly goals: number; readonly done: number; readonly failed: number; readonly stopped: number; readonly asked: number; readonly attempts: number; readonly microUsd: number; readonly tokens: number; readonly runMs: number };
  /** Goals started per day. */
  readonly calendar: readonly number[];
  /** Attempts started by weekday (0 is Monday) and hour: index `weekday * 24 + hour`. */
  readonly load: readonly number[];
  /** Per day: goals finished done, goals failed, and times a person was asked (approvals requested and questions asked). */
  readonly outcomes: ReadonlyArray<{ readonly done: number; readonly failed: number; readonly asked: number }>;
  readonly byWorkspace: readonly InsightRank[];
  readonly byAgent: readonly InsightRank[];
  readonly byPlay: readonly InsightRank[];
  readonly byTool: readonly InsightTool[];
  /** Goals of each Play, start to finish. */
  readonly playDurations: readonly InsightPercentiles[];
  /** Attempts of each agent, run time. */
  readonly agentDurations: readonly InsightPercentiles[];
  /** Per day: how long attempts waited between being queued and starting (n is 0 on a day with none). */
  readonly queueWait: ReadonlyArray<{ readonly n: number; readonly p50: number; readonly p90: number }>;
  readonly failures: readonly InsightFailure[];
  /** Goals started more than once with the same Play and inputs, or the same words. */
  readonly repeats: ReadonlyArray<{ readonly label: string; readonly play: string | null; readonly count: number; readonly microUsd: number; readonly lastTaskId: string; readonly workspaceSlug: string; readonly lastAt: number }>;
}
/** One day of a workspace's work, UTC: goals finished (done) and what the day cost. */
export interface OverviewDay { readonly day: string; readonly done: number; readonly microUsd: number }
/** One thing that happened to a task, as the Live feed tells it: a task finished, failed, started or needs a person, a check, an approved call. `id` is the audit event's position, so the same event is never told twice. */
export interface OverviewEvent {
  readonly id: number;
  readonly at: number;
  readonly type: "task.done" | "task.failed" | "task.stopped" | "task.running" | "task.needs_you" | "task.checked" | "approval.approved";
  readonly workspaceId: string;
  readonly taskId: string;
  readonly rootId: string;
  readonly goalTitle: string;
  readonly title: string;
  readonly agent: string | null;
  readonly goal: boolean;
  /** For `task.needs_you`, what the task waits for. */
  readonly need: TaskNeed["kind"] | null;
  /** For `task.checked`, whether the check passed. */
  readonly pass: boolean | null;
}
/** What one of the caller's workspaces is doing: counts of today, last two weeks, projects. */
export interface OverviewWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: Role;
  readonly visibility: "private" | "public";
  readonly platform: PlatformKind | null;
  /** Packs with a newer release than the one used. */
  readonly updates: number;
  readonly viaPublic: boolean;
  readonly projects: readonly string[];
  /** Tasks waiting for a person. */
  readonly needsYou: number;
  /** Goals started or running that wait for nothing from a person. */
  readonly running: number;
  /** Attempts in a runner now, and queued attempts waiting for one. */
  readonly attemptsRunning: number;
  readonly attemptsWaiting: number;
  readonly doneToday: number;
  readonly failedToday: number;
  /** Tasks under a goal that ended in the last hour, counted whatever the number of tasks. */
  readonly lastHour: { readonly done: number; readonly failed: number };
  readonly spend: Spend;
  readonly lastActivityAt: number | null;
  /** The last 14 days, oldest first, every day present; the last one is today. */
  readonly days: readonly OverviewDay[];
}
/** A task that waits for a person, with the workspace it is in and, for a call to approve, the approval itself. */
export interface OverviewNeed extends TaskSummary { readonly workspaceName: string; readonly workspaceSlug: string; readonly approval: Approval | null }
/** One attempt running now. */
export interface OverviewRun {
  readonly attemptId: string;
  readonly kind: AttemptKind;
  readonly agent: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly rootId: string;
  readonly taskId: string;
  readonly goalTitle: string;
  readonly title: string;
  readonly stepId: string | null;
  readonly startedAt: number | null;
  readonly microUsd: number;
}
/** The state of this Brain as a whole; only for an instance admin. Models are those whose answer is known (probes are kept a minute). */
export interface OverviewHealth {
  readonly runnersOnline: number;
  readonly runnersTotal: number;
  readonly modelsReachable: number;
  readonly modelsTotal: number;
  readonly auditProblem: string | null;
}
/** Everything the caller's workspaces are doing, on one screen. */
export interface Overview {
  readonly workspaces: readonly OverviewWorkspace[];
  /** The 50 most recent tasks waiting for a person, across the workspaces; the counts above are not limited. */
  readonly needsYou: readonly OverviewNeed[];
  /** The 30 attempts that started last and still run. */
  readonly running: readonly OverviewRun[];
  /** What happened to tasks in the last six hours, newest first (at most 80), across the workspaces; the Live feed tells it. */
  readonly events: readonly OverviewEvent[];
  /** The goals that finished in the last hour (at most 50), so that none is missed however busy the workspaces are. */
  readonly goalsDone: ReadonlyArray<{ readonly id: string; readonly title: string; readonly workspaceId: string; readonly at: number }>;
  readonly health: OverviewHealth | null;
}
/** A Play with a trigger, as the Schedules screen shows it. Times are from the Governor's own `triggers` row. */
export interface ScheduleItem {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  /** The IANA time zone a schedule is read in. */
  readonly timezone: string;
  /** The caller's role there: an admin can change the trigger. */
  readonly role: Role;
  readonly play: string;
  readonly title: string;
  readonly translations: PlayFile["translations"];
  /** `workspace`, or the pack whose Play it is (a change writes a workspace copy). */
  readonly source: string;
  readonly kind: "schedule" | "webhook";
  /** The cron expression, or the webhook event (`github.issues.opened`). */
  readonly spec: string;
  readonly paused: boolean;
  /** When the Governor will next start it; null for a webhook, a paused schedule or one that names no time. */
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastTask: { readonly id: string; readonly state: TaskState } | null;
  /** True when the last start's task still runs, so the next time will be skipped. */
  readonly skipsNext: boolean;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string }>;
}
export interface MemoryItem { readonly name: string; readonly title: string; readonly titles: Readonly<Partial<Record<Language, string>>>; readonly source: string }
export interface MemoryProposal {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly proposedBy: string;
  readonly taskId: string | null;
  readonly state: "pending" | "accepted" | "rejected";
  readonly at: number;
}
export interface Runner {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly capabilities: readonly RunnerCapability[];
  readonly engines: readonly string[];
  readonly slots: number;
  readonly freeSlots: number;
  readonly version: string;
  readonly lastSeenAt: number | null;
}
export interface Health {
  readonly version: string;
  readonly runners: readonly Runner[];
  readonly models: ReadonlyArray<{ readonly name: string; readonly reachable: boolean; readonly detail: string }>;
  readonly audit: { readonly events: number; readonly lastCheckpointAt: number | null; readonly problem: string | null };
  readonly backup: { readonly lastAt: number | null };
  /** Present when the workspace folder has a git remote. */
  readonly folderPush?: FolderPush | null;
}

// --- inputs ---

const id = z.string().min(1).max(100);
const workspaceId = id;
const inWorkspace = { workspaceId } as const;
const name = (what: string) => z.string().refine(isSlug, `${what} must be lower-case letters, digits and dashes, starting with a letter`);
const role = z.enum(ROLES);
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(12).max(128);
const personName = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(20_000);
const filePath = z.string().min(1).max(300);
const subtask = { title: z.string().trim().min(1).max(200), goal: text, agent: name("an agent name"), after: z.array(id).max(50).default([]) };

const table = <const D extends Record<string, readonly [ApiRole, z.ZodType]>>(definitions: D) =>
  Object.fromEntries(Object.entries(definitions).map(([type, [minimumRole, input]]) => [type, { type, role: minimumRole, input }])) as unknown as {
    readonly [K in keyof D]: { readonly type: K; readonly role: D[K][0]; readonly input: D[K][1] };
  };

export const commands = table({
  /** Creates the first person, as instance admin. `token` is the content of `<data>/setup.token`. */
  "setup.create": ["public", z.strictObject({ token: z.string().min(1).max(200), name: personName, email, password })],
  "workspace.create": ["instance-admin", z.strictObject({
    name: z.string().trim().min(1).max(100),
    /** The address: made from the name when left out, and read the same whatever its case or accents. */
    slug: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2000).default(""),
    packs: z.array(name("a pack name")).max(20).default([]),
    /** Makes it a platform workspace (docs/model.md, "The platform workspace"): at most one `admin`, any number of `read`. */
    platform: z.enum(PLATFORM_KINDS).optional(),
    /** A first model; `key` is stored as the secret `model-<name>`. */
    model: z.strictObject({ name: name("a model name").default("main"), provider: z.enum(["openai-compatible", "anthropic"]), url: z.string().min(1).max(500), model: z.string().min(1).max(200), key: z.string().min(1).max(10_000).optional() }).optional(),
    /** A first project; `credential` is stored as the secret `github`. The name is inferred from the address and the branch from the repository's own default (else `main`). */
    project: z.strictObject({ name: name("a project name").optional(), repo: z.string().min(1).max(500), branch: z.string().min(1).max(200).optional(), access: z.enum(["read", "write"]).default("read"), credential: z.string().min(1).max(10_000).optional() }).optional(),
    /** A git remote the workspace folder is pushed to after every commit (`[git]` of brain.toml). */
    folderRemote: z.string().trim().min(1).max(500).optional(),
  })],
  /** Releases a pack of the platform workspace: its version goes up by one and that content is frozen. */
  "pack.release": ["admin", z.strictObject({ ...inWorkspace, name: name("a pack name") })],
  "workspace.archive": ["admin", z.strictObject(inWorkspace)],
  "workspace.stopAll": ["member", z.strictObject(inWorkspace)],
  /** Writes files of the workspace folder in one commit, and removes the paths of `remove` in it (a rename). A `base64` file is bytes of a document. Refused with INVALID_WORKSPACE, and nothing written, when the folder would not be valid. */
  "file.write": ["admin", z.strictObject({ ...inWorkspace, files: z.array(z.strictObject({ path: filePath, content: z.string().max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4), encoding: z.enum(["utf8", "base64"]).default("utf8") })).max(200).default([]), remove: z.array(filePath).max(500).default([]), message: z.string().trim().min(1).max(200).optional() })],
  "file.delete": ["admin", z.strictObject({ ...inWorkspace, paths: z.array(filePath).min(1).max(500), message: z.string().trim().min(1).max(200).optional() })],
  "secret.set": ["admin", z.strictObject({ ...inWorkspace, name: name("a secret name"), value: z.string().min(1).max(10_000) })],
  "secret.delete": ["admin", z.strictObject({ ...inWorkspace, name: name("a secret name") })],
  /** Sets a person's role. A person with no account yet gets one, with the given name and first password. */
  "member.set": ["admin", z.strictObject({ ...inWorkspace, email, role, name: personName.optional(), password: password.optional() })],
  "member.remove": ["admin", z.strictObject({ ...inWorkspace, userId: id })],
  /** A goal, or a Play with its inputs. */
  "task.create": ["member", z.strictObject({ ...inWorkspace, goal: text.optional(), title: z.string().trim().min(1).max(200).optional(), play: name("a Play name").optional(), inputs: z.record(z.string(), z.json()).default({}) }).refine((input) => input.goal !== undefined || input.play !== undefined, "give a goal or a Play")],
  /** Accepts the plan proposed for a root task. */
  "task.confirm": ["member", z.strictObject({ ...inWorkspace, taskId: id })],
  /** Changes, adds or removes sub-tasks that have not started. The whole list is one edit: it is checked as it ends up, whatever the order of its changes. */
  "task.edit": ["member", z.strictObject({ ...inWorkspace, taskId: id, changes: z.array(z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("add"), ...subtask }),
    z.strictObject({ op: z.literal("change"), id, title: subtask.title.optional(), goal: text.optional(), agent: subtask.agent.optional(), after: z.array(id).max(50).optional() }),
    z.strictObject({ op: z.literal("remove"), id }),
  ])).min(1).max(100) })],
  "task.stop": ["member", z.strictObject({ ...inWorkspace, taskId: id })],
  /** A task's priority and whether it is paused (docs/model.md, The queue); what is not given stays as it is. */
  "task.steer": ["member", z.strictObject({ ...inWorkspace, taskId: id, priority: z.enum(PRIORITIES).optional(), paused: z.boolean().optional() }).refine((input) => input.priority !== undefined || input.paused !== undefined, "give a priority or paused")],
  "task.retry": ["member", z.strictObject({ ...inWorkspace, taskId: id })],
  /** A person's check or sign-off. `keep` names the candidate attempt a person judging keeps. */
  "task.check": ["member", z.strictObject({ ...inWorkspace, taskId: id, pass: z.boolean(), findings: z.string().trim().max(20_000).default(""), keep: id.optional() })],
  "task.answer": ["member", z.strictObject({ ...inWorkspace, taskId: id, answer: text })],
  /** `subjectDigest` is the digest of the subject the approver was shown; a decision on a changed subject is refused. */
  "approval.decide": ["member", z.strictObject({ ...inWorkspace, approvalId: id, decision: z.enum(["approve", "reject"]), subjectDigest: z.string().min(1).max(100), reason: z.string().trim().max(2000).default("") })],
  "memory.decide": ["admin", z.strictObject({ ...inWorkspace, proposalId: id, decision: z.enum(["accept", "reject"]) })],
  "runner.token": ["instance-admin", z.strictObject({ name: z.string().trim().min(1).max(100).optional() })],
  "runner.remove": ["instance-admin", z.strictObject({ runnerId: id })],
  /** Invites an address; one already invited gets a new link and the earlier one stops working. An address with an account is refused. */
  "user.invite": ["instance-admin", z.strictObject({ email, instanceAdmin: z.boolean().default(false), workspaces: z.array(z.strictObject({ workspaceId, role })).max(50).default([]), groups: z.array(id).max(50).default([]) })],
  "invitation.revoke": ["instance-admin", z.strictObject({ invitationId: id })],
  /** Redeems an invitation (a name and a password) or a reset link (a password) and, for an invitation, signs the person in. Anyone may call it; the token is the credential. */
  "invitation.accept": ["public", z.strictObject({ token: z.string().min(20).max(200), name: personName.optional(), password })],
  /** The instance role and whether the person may sign in; what is not given stays. The last active instance admin cannot be demoted or deactivated. */
  "user.set": ["instance-admin", z.strictObject({ userId: id, instanceAdmin: z.boolean().optional(), active: z.boolean().optional() }).refine((input) => input.instanceAdmin !== undefined || input.active !== undefined, "give a role or active")],
  "user.resetLink": ["instance-admin", z.strictObject({ userId: id })],
  /** Ends sessions: the caller's own (`userId` left out), or any person's for an instance admin. `sessionId` names one; `keepCurrent` spares the session making the request. */
  "session.revoke": ["public", z.strictObject({ userId: id.optional(), sessionId: id.optional(), keepCurrent: z.boolean().default(false) })],
  /** The caller's own name and password. Changing the password ends the other sessions. */
  "profile.set": ["public", z.strictObject({ name: personName.optional(), currentPassword: password.optional(), newPassword: password.optional() }).refine((input) => input.name !== undefined || input.newPassword !== undefined, "give a name or a new password").refine((input) => (input.newPassword === undefined) === (input.currentPassword === undefined), "give the current and the new password together")],
  /** Makes or changes a group: the whole set of its people and of its roles on workspaces. */
  "group.set": ["instance-admin", z.strictObject({ groupId: id.optional(), name: z.string().trim().min(1).max(60), memberIds: z.array(id).max(1000).default([]), grants: z.array(z.strictObject({ workspaceId, role })).max(200).default([]) })],
  "group.delete": ["instance-admin", z.strictObject({ groupId: id })],
});

export const queries = table({
  "setup.status": ["public", z.strictObject({})],
  /** Who is signed in (null when no one is) and the workspaces they are a member of. */
  me: ["public", z.strictObject({})],
  "packs.list": ["instance-admin", z.strictObject({})],
  "workspace.get": ["viewer", z.strictObject(inWorkspace)],
  /** The text files of a pack at `0` (shipped), a release, or `working` (the platform workspace's copy). */
  "pack.files": ["admin", z.strictObject({ ...inWorkspace, name: name("a pack name"), version: z.union([z.int().min(0), z.literal("working")]) })],
  /** Every file of the workspace folder and of its packs, a workspace file hiding the pack file it replaces. */
  "workspace.files": ["viewer", z.strictObject(inWorkspace)],
  "file.read": ["viewer", z.strictObject({ ...inWorkspace, path: filePath })],
  today: ["viewer", z.strictObject(inWorkspace)],
  /** What all the caller's workspaces are doing. Like `me` it takes no workspace; it answers UNAUTHENTICATED without a session and never shows a workspace the caller is not a member of. */
  overview: ["public", z.strictObject({})],
  /** Runners and the waiting list, for every workspace the caller sees, or for one; like `overview` it answers UNAUTHENTICATED without a session. */
  queue: ["public", z.strictObject({ workspaceId: id.optional() })],
  /** What happened over the last `days` days, for every workspace the caller sees or for one, in the caller's own days; like `queue` it answers UNAUTHENTICATED without a session. */
  insights: ["public", z.strictObject({ workspaceId: id.optional(), days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30), tzOffsetMinutes: z.int().min(-840).max(840).default(0) })],
  /** Every scheduled and webhook Play of the active workspaces the caller can see; like `overview` it takes no workspace and answers UNAUTHENTICATED without a session. */
  "schedules.list": ["public", z.strictObject({})],
  /** `search` matches the title or the goal text; `rootsOnly` leaves out sub-tasks. Both are applied before `limit`. */
  "tasks.list": ["viewer", z.strictObject({ ...inWorkspace, state: z.enum(TASK_STATES).optional(), parentId: id.optional(), rootsOnly: z.boolean().optional(), search: z.string().trim().min(1).max(200).optional(), before: z.int().optional(), limit: z.int().min(1).max(200).default(50) })],
  "task.get": ["viewer", z.strictObject({ ...inWorkspace, taskId: id })],
  /** The events of one attempt after `after`. */
  "task.events": ["viewer", z.strictObject({ ...inWorkspace, taskId: id, attemptId: id, after: z.int().min(0).default(0), limit: z.int().min(1).max(1000).default(200) })],
  "approvals.list": ["viewer", z.strictObject({ ...inWorkspace, state: z.enum(["pending", "approved", "rejected", "expired"]).optional(), limit: z.int().min(1).max(200).default(50) })],
  "approval.get": ["viewer", z.strictObject({ ...inWorkspace, approvalId: id })],
  "usage.summary": ["viewer", z.strictObject({ ...inWorkspace, days: z.int().min(1).max(90).default(14) })],
  "memory.list": ["viewer", z.strictObject(inWorkspace)],
  "members.list": ["admin", z.strictObject(inWorkspace)],
  "secrets.list": ["admin", z.strictObject(inWorkspace)],
  "runners.list": ["instance-admin", z.strictObject({})],
  health: ["viewer", z.strictObject(inWorkspace)],
  "audit.verify": ["instance-admin", z.strictObject({})],
  /** One page of the people and pending invitations (`search` matches name or address; `status` and `role` narrow it), how many match (`total`) and how many people there are of each kind (`counts`), and all the groups and the workspaces to give roles on. */
  "users.list": ["instance-admin", z.strictObject({ search: z.string().trim().max(100).optional(), status: z.enum(USER_STATES).optional(), role: z.enum(["admin", "member"]).optional(), page: z.int().min(0).default(0), pageSize: z.int().min(1).max(100).default(25) })],
  /** One person's detail: oneself (`userId` left out) or, for an instance admin, anyone. */
  "user.get": ["public", z.strictObject({ userId: id.optional() })],
});

// --- outputs ---

/** What a change to the workspace folder answers: the commit it made and the snapshot now active. */
export interface FileChange { readonly commit: string; readonly snapshotDigest: Digest }
export interface CommandOutputs {
  "setup.create": { readonly userId: string };
  "workspace.create": { readonly workspaceId: string; readonly slug: string; readonly snapshotDigest: Digest };
  "pack.release": { readonly version: number };
  "workspace.archive": Record<string, never>;
  "workspace.stopAll": { readonly stopped: number };
  "file.write": FileChange;
  "file.delete": FileChange;
  "secret.set": Record<string, never>;
  "secret.delete": Record<string, never>;
  "member.set": { readonly userId: string; readonly created: boolean };
  "member.remove": Record<string, never>;
  "task.create": { readonly taskId: string };
  "task.confirm": Record<string, never>;
  "task.edit": Record<string, never>;
  "task.stop": Record<string, never>;
  "task.steer": Record<string, never>;
  "task.retry": Record<string, never>;
  "task.check": Record<string, never>;
  "task.answer": Record<string, never>;
  "approval.decide": { readonly state: ApprovalState };
  "memory.decide": { readonly commit: string | null };
  "runner.token": { readonly token: string; readonly expiresAt: number };
  "runner.remove": Record<string, never>;
  /** `mail` says whether an email was handed to the mail server; whether it arrives is not known, so the link is always shown. */
  "user.invite": LinkOutput & { readonly invitationId: string; readonly mail: "off" | "queued" };
  "invitation.revoke": Record<string, never>;
  "invitation.accept": { readonly kind: "invite" | "reset"; readonly userId: string };
  "user.set": Record<string, never>;
  "user.resetLink": LinkOutput;
  "session.revoke": { readonly revoked: number };
  "profile.set": Record<string, never>;
  "group.set": { readonly groupId: string };
  "group.delete": Record<string, never>;
}
export interface QueryOutputs {
  "setup.status": { readonly setupRequired: boolean };
  me: { readonly user: User | null; readonly workspaces: readonly WorkspaceSummary[] };
  "packs.list": { readonly packs: readonly PackInfo[] };
  "pack.files": { readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }> };
  "workspace.get": Workspace;
  "workspace.files": { readonly files: readonly FileEntry[] };
  "file.read": FileContent;
  today: Today;
  overview: Overview;
  queue: Queue;
  insights: Insights;
  "schedules.list": { readonly schedules: readonly ScheduleItem[] };
  "tasks.list": { readonly tasks: readonly TaskSummary[] };
  "task.get": Task;
  "task.events": { readonly events: readonly AttemptEvent[] };
  "approvals.list": { readonly approvals: readonly Approval[] };
  "approval.get": Approval;
  "usage.summary": UsageSummary;
  "memory.list": { readonly entries: readonly MemoryItem[]; readonly proposals: readonly MemoryProposal[] };
  "members.list": { readonly members: readonly Member[]; readonly groups: readonly MemberGroup[] };
  /** Names only. `missing` are the secrets the active snapshot refers to that are not set. */
  "secrets.list": { readonly secrets: readonly SecretName[]; readonly missing: readonly string[] };
  "runners.list": { readonly runners: readonly Runner[] };
  health: Health;
  "audit.verify": AuditVerifyResult;
  "users.list": { readonly users: readonly UserRow[]; readonly total: number; readonly counts: { readonly active: number; readonly invited: number; readonly deactivated: number; readonly admins: number }; readonly groups: readonly GroupRow[]; readonly workspaces: ReadonlyArray<{ readonly id: string; readonly name: string }> };
  "user.get": UserDetail;
}
export type CommandType = keyof typeof commands;
export type QueryType = keyof typeof queries;
/** What a caller sends (before defaults) and what a handler is given (after them). */
export type CommandRequest<T extends CommandType> = z.input<(typeof commands)[T]["input"]>;
export type CommandInput<T extends CommandType> = z.output<(typeof commands)[T]["input"]>;
export type QueryRequest<T extends QueryType> = z.input<(typeof queries)[T]["input"]>;
export type QueryInput<T extends QueryType> = z.output<(typeof queries)[T]["input"]>;
