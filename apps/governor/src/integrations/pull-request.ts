import { secretName, type Digest, type JsonValue, type SnapshotManifest } from "@brain/contracts";
import git, { type HttpClient } from "isomorphic-git";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inheritedPatches, baseCommitOf } from "../attempts/offer";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { append } from "../events";
import type { AttemptRow, TaskRow } from "../tasks/store";
import type { PullRequestChange } from "../trust/approvals";
import { linkArtifact, putArtifact, readArtifact } from "../trust/artifacts";
import { readSecret } from "../trust/secrets";
import { ToolRefusal } from "../tools/schema";
import { manifestOf } from "../workspace/store";
import { repoPath } from "./github";
import { applyPatch, PatchConflict, projectPatch } from "./patch";

/**
 * `git.open-pr` (docs/architecture.md section 8): code changes leave a task only here. The Governor clones the project at the commit the
 * task worked on, applies the task's working-copy changes, commits, pushes `brain/<task id>` with the project's credential and opens
 * the pull request through the GitHub API. Nothing merges.
 */

/**
 * The whole change a pull request of this attempt would carry, stored as one patch so that an approver is shown exactly what will be
 * opened: the patches of the tasks this one started from, then what the attempt itself last uploaded (or what the task's earlier attempt left).
 * With it, the commit the change is made on: the one the attempt's working copy stands on, as its runner said with the call (`commits`),
 * else the one the goal already works on. A goal's first attempt has reported none before it ends, so only its runner knows it.
 */
export function pullRequestChange(gov: Gov, attempt: AttemptRow, task: TaskRow, projectName: string, commits: Readonly<Record<string, string>> = {}): PullRequestChange {
  const { db } = gov;
  // What can be told before anyone is asked is told now: the project must be one this workspace may change.
  const project = writable(gov, task, projectName);
  const own = (db.prepare("SELECT digest FROM artifact_links WHERE attempt_id=? AND kind='patch' ORDER BY id DESC LIMIT 1").get(attempt.id) as { digest: Digest } | undefined)?.digest
    ?? (db.prepare("SELECT working_copy AS digest FROM attempts WHERE task_id=? AND kind='work' AND working_copy IS NOT NULL AND candidate IS ? ORDER BY rowid DESC LIMIT 1").get(task.id, attempt.candidate) as { digest: Digest } | undefined)?.digest;
  const parts = [...inheritedPatches(db, task), ...(own ? [own] : [])].map((digest) => Buffer.from(readArtifact(gov, digest))).filter((bytes) => bytes.length > 0);
  const whole = Buffer.concat(parts.flatMap((bytes) => (bytes.at(-1) === 0x0a ? [bytes] : [bytes, Buffer.from("\n")])));
  if (projectPatch(whole, project.name).length === 0) throw new ToolRefusal(`The working copy has no changes in ${project.name}, so there is nothing to open a pull request from`);
  const digest = putArtifact(gov, whole);
  linkArtifact(db, { digest, workspaceId: task.workspace_id, taskId: task.id, attemptId: attempt.id, name: "pull-request.patch", kind: "pull-request", mediaType: "text/x-diff" }, gov.clock.nowMs());
  const baseCommit = commits[project.name] ?? baseCommitOf(gov, task, project.name);
  return { patchDigest: digest, ...(baseCommit !== undefined ? { baseCommit } : {}) };
}

function writable(gov: Gov, task: TaskRow, name: string): SnapshotManifest["projects"][number] {
  const { projects } = manifestOf(gov, task.snapshot_digest);
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) throw new ToolRefusal(`There is no project "${name}". The projects are: ${projects.map((candidate) => candidate.name).join(", ") || "none"}`);
  if (project.access !== "write") throw new ToolRefusal(`The project ${project.name} is read-only for this workspace (access = "read"), so no pull request can be opened on it`);
  return project;
}

/** isomorphic-git's HTTP client over the Governor's own `fetch`. */
const httpOver = (send: typeof fetch): HttpClient => ({
  async request({ url, method = "GET", headers = {}, body }) {
    const chunks: Uint8Array[] = [];
    if (body) for await (const chunk of body) chunks.push(chunk);
    const response = await send(url, { method, headers, ...(body ? { body: Buffer.concat(chunks) } : {}) });
    const answered: Record<string, string> = {};
    response.headers.forEach((value, name) => { answered[name] = value; });
    return { url: response.url || url, method, statusCode: response.status, statusMessage: response.statusText, headers: answered, body: [new Uint8Array(await response.arrayBuffer())] as unknown as AsyncIterableIterator<Uint8Array> };
  },
});

interface OpenedPullRequest { readonly url: string; readonly number: number; readonly branch: string }

/** Opens the pull request an approval was given for: `change` is the patch and the commit of the approved subject. */
export async function openPullRequest(gov: Gov, attempt: AttemptRow, task: TaskRow, input: { project: string; title: string; body: string }, change: PullRequestChange & { patchDigest: Digest }): Promise<OpenedPullRequest> {
  const { patchDigest, baseCommit: base } = change;
  const project = writable(gov, task, input.project);
  const credential = project.credential ?? manifestOf(gov, task.snapshot_digest).github?.credential;
  const token = credential ? readSecret(gov, task.workspace_id, secretName(credential)) : undefined;
  if (!token) throw new ToolRefusal(`The project ${project.name} has no credential set, so its branch cannot be pushed`);
  const patch = projectPatch(readArtifact(gov, patchDigest), project.name);

  const branch = `brain/${task.id}`;
  const http = httpOver(gov.fetch);
  // The credential goes with every request to the repository, as a header; it is never part of an address.
  const headers = { authorization: `Basic ${Buffer.from(token.includes(":") ? token : `x-access-token:${token}`).toString("base64")}` };
  const dir = fs.mkdtempSync(join(tmpdir(), "brain-pr-"));
  try {
    await git.clone({ fs, http, dir, url: project.repo, ref: project.branch, singleBranch: true, noTags: true, headers });
    if (base !== undefined) await git.checkout({ fs, dir, ref: base, force: true }).catch(() => { throw new ToolRefusal(`The commit ${base} this task worked on is not on the branch ${project.branch} of ${project.name}`); });
    await git.branch({ fs, dir, ref: branch, checkout: true, force: true });
    let changed;
    try {
      changed = applyPatch(patch, (path) => (fs.existsSync(join(dir, path)) ? new Uint8Array(fs.readFileSync(join(dir, path))) : undefined));
    } catch (e) {
      if (e instanceof PatchConflict) throw new ToolRefusal(`The changes do not apply to ${project.name} at ${base ?? `the head of ${project.branch}`}: ${e.paths.join(", ")}`);
      throw e;
    }
    for (const file of changed) {
      if (file.path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")) throw new ToolRefusal(`The change names a path outside the project: ${file.path}`);
      const at = join(dir, file.path);
      fs.rmSync(at, { force: true });
      if (file.content === undefined) {
        await git.remove({ fs, dir, filepath: file.path });
        continue;
      }
      fs.mkdirSync(dirname(at), { recursive: true });
      if (file.mode === "120000") fs.symlinkSync(Buffer.from(file.content).toString("utf8"), at);
      else fs.writeFileSync(at, file.content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
      await git.add({ fs, dir, filepath: file.path });
    }
    const author = { name: "Brain", email: "brain@localhost" };
    const commit = await git.commit({ fs, dir, message: `${input.title}\n\n${input.body}\n`, author, committer: author });
    const pushed = await git.push({ fs, http, dir, url: project.repo, ref: branch, remoteRef: `refs/heads/${branch}`, force: true, headers });
    if (!pushed.ok) throw new ToolRefusal(`The branch ${branch} could not be pushed to ${project.name}: ${pushed.error ?? "the server refused it"}`);

    // A task that opens its pull request again (after findings) has moved the branch; the pull request it already has follows the branch.
    const known = gov.db.prepare("SELECT url, number FROM pull_requests WHERE task_id=? AND project=? ORDER BY id DESC LIMIT 1").get(task.id, project.name) as { url: string; number: number } | undefined;
    if (known) return { ...known, branch };
    const origin = new URL(project.repo).origin;
    const api = origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
    const response = await gov.fetch(`${api}/repos/${repoPath(project.repo)}/pulls`, {
      method: "POST", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", accept: "application/vnd.github+json", "user-agent": "Brain", authorization: `Bearer ${token.slice(token.indexOf(":") + 1)}` },
      body: JSON.stringify({ title: input.title, head: branch, base: project.branch, body: input.body }),
    });
    const answer = (response.ok ? await response.json() : {}) as { number?: unknown; html_url?: unknown; state?: unknown };
    if (typeof answer.number !== "number" || typeof answer.html_url !== "string") throw new ToolRefusal(`GitHub did not open the pull request (it answered ${response.status}); the branch ${branch} was pushed`);
    const opened = { url: answer.html_url, number: answer.number, branch };
    tx(gov.db, () => {
      gov.db.prepare("INSERT INTO pull_requests(workspace_id, task_id, attempt_id, project, branch, url, number, state, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(task.workspace_id, task.id, attempt.id, project.name, branch, opened.url, opened.number, typeof answer.state === "string" ? answer.state : "open", gov.clock.nowMs());
      append(gov.db, { type: "pullRequest.opened", workspaceId: task.workspace_id, subject: `task:${task.id}`, payload: { ...opened, project: project.name, commit, patchDigest } as JsonValue, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } });
    });
    return opened;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
