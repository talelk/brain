import { z } from "zod";
import type { AuditVerifyResult } from "./audit-chain";
import { isSlug, MAX_FILE_BYTES, PLATFORM_KINDS, type PlatformKind, type Language, type PackFile, type PlayFile, type Problem, type SnapshotManifest } from "./files";
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

export interface User { readonly id: string; readonly name: string; readonly email: string; readonly instanceAdmin: boolean }
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
export interface Member { readonly userId: string; readonly name: string; readonly email: string; readonly role: Role }
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
/** One day of a workspace's work, UTC: goals finished (done) and what the day cost. */
export interface OverviewDay { readonly day: string; readonly done: number; readonly microUsd: number }
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
  readonly doneToday: number;
  readonly failedToday: number;
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
  "task.retry": ["member", z.strictObject({ ...inWorkspace, taskId: id })],
  /** A person's check or sign-off. `keep` names the candidate attempt a person judging keeps. */
  "task.check": ["member", z.strictObject({ ...inWorkspace, taskId: id, pass: z.boolean(), findings: z.string().trim().max(20_000).default(""), keep: id.optional() })],
  "task.answer": ["member", z.strictObject({ ...inWorkspace, taskId: id, answer: text })],
  /** `subjectDigest` is the digest of the subject the approver was shown; a decision on a changed subject is refused. */
  "approval.decide": ["member", z.strictObject({ ...inWorkspace, approvalId: id, decision: z.enum(["approve", "reject"]), subjectDigest: z.string().min(1).max(100), reason: z.string().trim().max(2000).default("") })],
  "memory.decide": ["admin", z.strictObject({ ...inWorkspace, proposalId: id, decision: z.enum(["accept", "reject"]) })],
  "runner.token": ["instance-admin", z.strictObject({ name: z.string().trim().min(1).max(100).optional() })],
  "runner.remove": ["instance-admin", z.strictObject({ runnerId: id })],
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
  "task.retry": Record<string, never>;
  "task.check": Record<string, never>;
  "task.answer": Record<string, never>;
  "approval.decide": { readonly state: ApprovalState };
  "memory.decide": { readonly commit: string | null };
  "runner.token": { readonly token: string; readonly expiresAt: number };
  "runner.remove": Record<string, never>;
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
  "schedules.list": { readonly schedules: readonly ScheduleItem[] };
  "tasks.list": { readonly tasks: readonly TaskSummary[] };
  "task.get": Task;
  "task.events": { readonly events: readonly AttemptEvent[] };
  "approvals.list": { readonly approvals: readonly Approval[] };
  "approval.get": Approval;
  "usage.summary": UsageSummary;
  "memory.list": { readonly entries: readonly MemoryItem[]; readonly proposals: readonly MemoryProposal[] };
  "members.list": { readonly members: readonly Member[] };
  /** Names only. `missing` are the secrets the active snapshot refers to that are not set. */
  "secrets.list": { readonly secrets: readonly SecretName[]; readonly missing: readonly string[] };
  "runners.list": { readonly runners: readonly Runner[] };
  health: Health;
  "audit.verify": AuditVerifyResult;
}
export type CommandType = keyof typeof commands;
export type QueryType = keyof typeof queries;
/** What a caller sends (before defaults) and what a handler is given (after them). */
export type CommandRequest<T extends CommandType> = z.input<(typeof commands)[T]["input"]>;
export type CommandInput<T extends CommandType> = z.output<(typeof commands)[T]["input"]>;
export type QueryRequest<T extends QueryType> = z.input<(typeof queries)[T]["input"]>;
export type QueryInput<T extends QueryType> = z.output<(typeof queries)[T]["input"]>;
