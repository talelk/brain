import { canonicalJsonBytes, MAX_FILE_BYTES, pathProblem, type Digest, type JsonSchema, type JsonValue, type SnapshotManifest } from "@brain/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gov } from "../dispatch";
import { reviveTask, settle } from "../tasks/orchestrator";
import { healedBy } from "../tasks/heal";
import { taskOf, type AttemptRow, type TaskRow } from "../tasks/store";
import { linkArtifact, putArtifact } from "../trust/artifacts";
import { classifyPath, readPack, releasedDirOf } from "../workspace/files";
import { platformOf } from "../workspace/platform";
import { activate, checkFolder, commitFolder, commitOf, getWorkspace, manifestOf, workspaceDir, type Committed } from "../workspace/store";
import { ToolRefusal } from "./schema";
import { schemaProblem } from "@brain/contracts/validate";

/**
 * `workspace.fix` (docs/model.md, "When a task fails"): a heal task's agent proposes a change of the workspace's files for the task it heals.
 * The change is checked and stored as a diff before anyone is asked, committed only once an admin approved exactly it, and then the failed task runs again.
 */
const MAX_FILES = 20;
/** Proposals one platform task may make, each with its own approval. */
const MAX_PROPOSALS = 10;
const WRITABLE = /^(?:brain\.toml|(?:agents|tools|plays|memory|docs)\/.+)$/u;
/** What a task of the platform workspace that is not a heal task may change: the pack sources it keeps. */
const PLATFORM_WRITABLE = /^packs\/[a-z][a-z0-9-]*\/.+$/u;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

interface FixInput { readonly task?: string | undefined; readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>; readonly message: string; readonly why: string }
/** What a proposal is bound to: the diff the approver reads and the commit it was made on. */
export interface FixPlan { readonly patchDigest: Digest; readonly baseCommit: string }

function inputOf(input: JsonValue): FixInput {
  const value = input as { readonly [name: string]: JsonValue };
  const files = value["files"] as JsonValue[];
  if (files.length === 0 || files.length > MAX_FILES) throw new ToolRefusal(`Change between 1 and ${MAX_FILES} files in one fix`);
  const named = files.map((file) => {
    const entry = file as { readonly [name: string]: JsonValue } | null;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry["path"] !== "string" || typeof entry["content"] !== "string" || Object.keys(entry).length !== 2) {
      throw new ToolRefusal('Every item of "files" must be {"path": string, "content": string}, the whole new content of the file');
    }
    return { path: entry["path"], content: entry["content"] };
  });
  return { task: value["task"] as string | undefined, files: named, message: (value["message"] as string).trim(), why: value["why"] as string };
}

/** The text of a file as the workspace has it now: its own folder first, then the packs it uses, the last pack first. */
export function currentText(gov: Gov, slug: string, manifest: SnapshotManifest, path: string): string | undefined {
  if (pathProblem(path) !== undefined) return undefined;
  const own = join(workspaceDir(gov, slug), path);
  if (existsSync(own)) return text(new Uint8Array(readFileSync(own)));
  for (const pack of [...manifest.packs].reverse()) {
    const found = readPack(gov.packsDir, pack, manifest.pins?.[pack], releasedDirOf(gov.dataDir))?.get(path);
    if (found) return text(found);
  }
  return undefined;
}

// --- the diff an approver reads ---

/** Lines changed between two texts, as a unified diff with three lines of context. Texts too long for the comparison are shown as replaced whole. */
function unifiedDiff(path: string, before: string | undefined, after: string): string {
  const old = before === undefined || before === "" ? [] : before.replace(/\n$/u, "").split("\n");
  const now = after === "" ? [] : after.replace(/\n$/u, "").split("\n");
  type Edit = { readonly kind: " " | "-" | "+"; readonly line: string };
  const edits: Edit[] = [];
  if (old.length * now.length > 4_000_000) {
    for (const line of old) edits.push({ kind: "-", line });
    for (const line of now) edits.push({ kind: "+", line });
  } else {
    const table = Array.from({ length: old.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
    for (let i = old.length - 1; i >= 0; i -= 1) for (let j = now.length - 1; j >= 0; j -= 1) table[i]![j] = old[i] === now[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < old.length || j < now.length) {
      if (i < old.length && j < now.length && old[i] === now[j]) { edits.push({ kind: " ", line: old[i] as string }); i += 1; j += 1; }
      else if (j < now.length && (i === old.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { edits.push({ kind: "+", line: now[j] as string }); j += 1; }
      else { edits.push({ kind: "-", line: old[i] as string }); i += 1; }
    }
  }
  const head = [`diff --git a/${path} b/${path}`, ...(before === undefined ? ["new file mode 100644"] : []), `--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  const changed = edits.flatMap((edit, at) => (edit.kind === " " ? [] : [at]));
  const out: string[] = [];
  let from = 0;
  while (from < changed.length) {
    let to = from;
    while (to + 1 < changed.length && (changed[to + 1] as number) - (changed[to] as number) <= 7) to += 1;
    const start = Math.max(0, (changed[from] as number) - 3);
    const end = Math.min(edits.length, (changed[to] as number) + 4);
    const slice = edits.slice(start, end);
    const oldStart = edits.slice(0, start).filter((edit) => edit.kind !== "+").length + 1;
    const newStart = edits.slice(0, start).filter((edit) => edit.kind !== "-").length + 1;
    out.push(`@@ -${oldStart},${slice.filter((edit) => edit.kind !== "+").length} +${newStart},${slice.filter((edit) => edit.kind !== "-").length} @@`, ...slice.map((edit) => `${edit.kind}${edit.line}`));
    from = to + 1;
  }
  return [...head, ...out].join("\n");
}

// --- asking ---

/**
 * Checks a proposal before a person is asked: it is a heal task's own failed task, one proposal at a time, only files a heal may change, and the workspace
 * stays valid. Returns the diff to show (stored under its digest) and the commit the diff was made on; refuses in words the healer can act on.
 */
export async function planFix(gov: Gov, attempt: AttemptRow, task: TaskRow, rowId: string, schema: JsonSchema, rawInput: JsonValue): Promise<FixPlan> {
  const { db } = gov;
  const problem = schemaProblem(schema, rawInput);
  if (problem) throw new ToolRefusal(`The input of workspace.fix is not valid: ${problem}`);
  const input = inputOf(rawInput);
  const earlier = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE task_id=? AND tool='workspace.fix' AND id != ? AND outcome IN ('pending','held','succeeded','rejected')").get(task.id, rowId) as { n: number };
  let failed: TaskRow | undefined;
  const root = taskOf(db, task.root_id);
  const healed = healedBy(root);
  if (healed !== undefined) {
    if (root.id !== task.id) throw new ToolRefusal("workspace.fix is only for the task that heals a failed task");
    if (input.task !== undefined && input.task !== healed) throw new ToolRefusal(`Your task heals ${healed}; "task" must be that id`);
    failed = taskOf(db, healed);
    if (failed.state !== "failed") throw new ToolRefusal(`The task ${healed} is ${failed.state}, not failed: nothing is left to fix`);
    if (earlier.n > 0) throw new ToolRefusal("One fix was already proposed for this task; make no other");
  } else {
    if (platformOf(gov, task.workspace_id)?.kind !== "admin") throw new ToolRefusal("workspace.fix is only for the task that heals a failed task, or for a task of the admin workspace");
    if (input.task !== undefined) throw new ToolRefusal('"task" is only for the task that heals a failed task: leave it out');
    if (earlier.n >= MAX_PROPOSALS) throw new ToolRefusal(`A task makes at most ${MAX_PROPOSALS} proposals`);
  }
  const seen = new Set<string>();
  for (const { path } of input.files) {
    const allowed = failed === undefined ? PLATFORM_WRITABLE.test(path) : WRITABLE.test(path);
    if (!allowed || !classifyPath(path) || pathProblem(path) !== undefined) throw new ToolRefusal(`${path} is not a file you may change: ${failed === undefined ? "only the pack sources under packs/<pack>/" : "only brain.toml and files under agents/, tools/, plays/, memory/ and docs/"}`);
    if (seen.has(path)) throw new ToolRefusal(`${path} is written twice`);
    seen.add(path);
  }
  const write = new Map(input.files.map((file) => [file.path, bytes(file.content)] as const));
  for (const [path, content] of write) if (content.length > MAX_FILE_BYTES) throw new ToolRefusal(`${path} is too large`);
  const workspace = getWorkspace(db, task.workspace_id);
  const active = manifestOf(gov, workspace.snapshotDigest);
  let checked;
  try {
    checked = await checkFolder(gov, workspace.slug, { write, remove: [] });
  } catch (e) {
    const problems = (e as { problems?: ReadonlyArray<{ path: string; message: string }> }).problems;
    throw new ToolRefusal(`The workspace would not be valid with this change: ${(problems ?? []).map((one) => `${one.path}: ${one.message}`).join("; ") || (e as Error).message}`);
  }
  const { manifest } = checked;
  for (const key of ["approvals", "github", "git", "teams", "platform", "models", "projects"] as const) {
    if (Buffer.compare(canonicalJsonBytes((manifest[key] ?? null) as JsonValue), canonicalJsonBytes((active[key] ?? null) as JsonValue)) !== 0) throw new ToolRefusal(`A fix does not change "${key}" of brain.toml: that is decided by an admin in the settings`);
  }
  if (failed?.agent && !manifest.agents[failed.agent]) throw new ToolRefusal(`The change removes the agent ${failed.agent}, which the failed task needs`);
  const parts: string[] = [];
  for (const [path, content] of write) {
    const before = checked.before.has(path) ? text(checked.before.get(path) as Uint8Array) : currentText(gov, workspace.slug, active, path);
    if (before === text(content)) continue;
    parts.push(unifiedDiff(path, before, text(content)));
  }
  if (parts.length === 0) throw new ToolRefusal("The files you sent are the files the workspace already has; there is nothing to fix");
  const patchDigest = putArtifact(gov, bytes(`${parts.join("\n")}\n`));
  linkArtifact(db, { digest: patchDigest, workspaceId: task.workspace_id, taskId: task.id, attemptId: attempt.id, name: "workspace-fix.patch", kind: "patch", mediaType: "text/x-diff" }, gov.clock.nowMs());
  return { patchDigest, baseCommit: commitOf(db, workspace.id, workspace.snapshotDigest) };
}

// --- carrying it out ---

/** The refusal of a proposal whose workspace moved on after it was made. */
export class WorkspaceChanged extends ToolRefusal {}

/** Commits an approved proposal, as `file.write` does. Refused when the workspace changed since the proposal was made. */
export async function commitFix(gov: Gov, task: TaskRow, rawInput: JsonValue, baseCommit: string | undefined): Promise<Committed> {
  const input = inputOf(rawInput);
  const workspace = getWorkspace(gov.db, task.workspace_id);
  const changed = new WorkspaceChanged("The workspace changed after this fix was proposed, so the approval no longer fits it. Propose the fix again from the new files");
  if (baseCommit !== commitOf(gov.db, workspace.id, workspace.snapshotDigest)) throw changed;
  const healed = healedBy(task);
  return commitFolder(gov, workspace.slug, {
    write: new Map(input.files.map((file) => [file.path, bytes(file.content)] as const)), remove: [], instanceAdmin: false,
    // Checked again when the folder's turn comes, so a change made between the check above and the commit is not overwritten.
    onlyAtCommit: { commit: baseCommit, refusal: changed },
    message: `${input.message.slice(0, 160)}\n\n${healed !== undefined ? `Heals task ${healed}` : `Proposed by platform task ${task.id}`}`,
    author: { name: task.agent ?? "workspace-healer", email: "brain@localhost" },
  });
}

/**
 * In the transaction that records the call: the committed folder becomes the active snapshot. For a heal, the failed task, with the sub-tasks that failed under it,
 * is moved onto it and queued again (a task a person already retried or stopped is left as it is). A platform task's change revives nothing.
 */
export function applyFix(gov: Gov, attempt: AttemptRow, task: TaskRow, committed: Committed): JsonValue {
  const actor = { kind: "agent" as const, id: attempt.agent, attemptId: attempt.id };
  activate(gov, gov.db, task.workspace_id, committed, actor, "workspace.changed");
  const healed = healedBy(task);
  if (healed === undefined) return { commit: committed.commit, requeued: false };
  const failed = taskOf(gov.db, healed);
  const requeued = failed.state === "failed";
  if (requeued) {
    gov.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
      UPDATE tasks SET snapshot_digest=? WHERE id IN (SELECT id FROM tree) AND state IN ('failed','stopped')`).run(failed.id, committed.snapshotDigest);
    reviveTask(gov, taskOf(gov.db, failed.id), actor);
    settle(gov, task.workspace_id);
  }
  return { commit: committed.commit, requeued };
}
