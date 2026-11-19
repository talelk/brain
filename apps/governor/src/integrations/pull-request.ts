import { secretName, signStoreGrant, type Digest, type JsonValue, type SnapshotManifest } from "@brain/contracts";
import git, { type HttpClient } from "isomorphic-git";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseCommitOf, credentialOf } from "../attempts/offer";
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

/**
 * `git.open-pr` (docs/architecture.md section 8): code changes leave a task only here. The Governor clones the project at the commit the
 * task worked on, fetches the state commit the approval was given for from the git store, makes one commit of its tree on the project's commit,
 * pushes `brain/<task id>` with the project's credential and opens the pull request through the GitHub API. Nothing merges.
 */

/** The part of a diff that concerns one project: the file sections (each starts at a `diff --git` line) whose paths start with `<project>/`. */
export function projectDiff(diff: Uint8Array, project: string): Buffer {
  const buffer = Buffer.from(diff);
  const starts: number[] = [];
  for (let at = buffer.indexOf("diff --git "); at >= 0; at = buffer.indexOf("diff --git ", at + 1)) if (at === 0 || buffer[at - 1] === 0x0a) starts.push(at);
  const mine = starts.flatMap((start, index) => {
    const line = buffer.subarray(start, buffer.indexOf("\n", start)).toString("latin1");
    return line.startsWith(`diff --git a/${project}/`) || line.startsWith(`diff --git "a/${project}/`) ? [buffer.subarray(start, starts[index + 1] ?? buffer.length)] : [];
  });
  return Buffer.concat(mine);
}

/**
 * What a pull request of this attempt would carry: the diff of the project the approver reads (stored as an artifact), the state commit that was
 * pushed to the store (the one the attempt's runner said with the call, else what the attempt or the task's earlier attempt last pushed), and the
 * commit the change is made on: the one the attempt's working copy stands on, as its runner said with the call (`commits`), else the one the goal
 * already works on. A goal's first attempt has reported none before it ends, so only its runner knows it.
 */
export function pullRequestChange(gov: Gov, attempt: AttemptRow, task: TaskRow, projectName: string, commits: Readonly<Record<string, string>> = {}, states: Readonly<Record<string, string>> = {}): PullRequestChange {
  const { db } = gov;
  // What can be told before anyone is asked is told now: the project must be one this workspace may change.
  const project = writable(gov, task, projectName);
  const earlier = db.prepare("SELECT working_copy AS diff, payload_json AS payload FROM attempts WHERE task_id=? AND kind='work' AND working_copy IS NOT NULL AND candidate IS ? ORDER BY rowid DESC LIMIT 1").get(task.id, attempt.candidate) as { diff: Digest; payload: string } | undefined;
  const own = (db.prepare("SELECT digest FROM artifact_links WHERE attempt_id=? AND kind='patch' ORDER BY id DESC LIMIT 1").get(attempt.id) as { digest: Digest } | undefined)?.digest ?? earlier?.diff;
  const stateCommit = states[project.name] ?? (JSON.parse(attempt.payload_json) as { stateCommits?: Record<string, string> }).stateCommits?.[project.name] ?? (earlier ? (JSON.parse(earlier.payload) as { stateCommits?: Record<string, string> }).stateCommits?.[project.name] : undefined);
  const shown = own ? projectDiff(readArtifact(gov, own), project.name) : Buffer.alloc(0);
  if (stateCommit === undefined || shown.length === 0) throw new ToolRefusal(`The working copy has no changes in ${project.name}, so there is nothing to open a pull request from`);
  const digest = putArtifact(gov, shown);
  linkArtifact(db, { digest, workspaceId: task.workspace_id, taskId: task.id, attemptId: attempt.id, name: "pull-request.patch", kind: "pull-request", mediaType: "text/x-diff" }, gov.clock.nowMs());
  const baseCommit = commits[project.name] ?? baseCommitOf(gov, task, project.name);
  return { patchDigest: digest, stateCommit, ...(baseCommit !== undefined ? { baseCommit } : {}) };
}

function writable(gov: Gov, task: TaskRow, name: string): SnapshotManifest["projects"][number] {
  const { projects } = manifestOf(gov, task.snapshot_digest);
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) throw new ToolRefusal(`There is no project "${name}". The projects are: ${projects.map((candidate) => candidate.name).join(", ") || "none"}`);
  if (project.access !== "write") throw new ToolRefusal(`The project ${project.name} is read-only for this workspace (access = "read"), so no pull request can be opened on it`);
  return project;
}

/** isomorphic-git's HTTP client over the Governor's own `fetch`. */
export const httpOver = (send: typeof fetch): HttpClient => ({
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

/** Opens the pull request an approval was given for: `change` is the diff that was shown, the state commit and the commit of the approved subject. */
export async function openPullRequest(gov: Gov, attempt: AttemptRow, task: TaskRow, input: { project: string; title: string; body: string }, change: PullRequestChange & { patchDigest: Digest; stateCommit: string }): Promise<OpenedPullRequest> {
  const { patchDigest, stateCommit, baseCommit: base } = change;
  const project = writable(gov, task, input.project);
  const credential = credentialOf(manifestOf(gov, task.snapshot_digest), project);
  const token = credential ? readSecret(gov, task.workspace_id, secretName(credential)) : undefined;
  if (!token) throw new ToolRefusal(`The project ${project.name} has no credential set, so its branch cannot be pushed`);
  if (!gov.store) throw new ToolRefusal("This Governor has no git store (BRAIN_STORE_URL), so the state of the change cannot be read");

  const branch = `brain/${task.id}`;
  const http = httpOver(gov.fetch);
  // The credential goes with every request to the repository, as a header; it is never part of an address.
  const headers = { authorization: `Basic ${Buffer.from(token.includes(":") ? token : `x-access-token:${token}`).toString("base64")}` };
  const dir = fs.mkdtempSync(join(tmpdir(), "brain-pr-"));
  try {
    await git.clone({ fs, http, dir, url: project.repo, ref: project.branch, singleBranch: true, noTags: true, depth: 1, headers });
    // The clone holds only the branch head; a task that worked on an older commit deepens it step by step until that commit is there
    // (isomorphic-git cannot fetch a commit by its id alone).
    const present = (): Promise<boolean> => git.readCommit({ fs, dir, oid: base! }).then(() => true, () => false);
    if (base !== undefined) for (const depth of [50, 500, 5000]) {
      if (await present()) break;
      await git.fetch({ fs, http, dir, url: project.repo, ref: project.branch, singleBranch: true, depth, tags: false, headers }).catch(() => undefined);
    }
    if (base !== undefined && !(await present())) throw new ToolRefusal(`The commit ${base} this task worked on is not on the branch ${project.branch} of ${project.name}`);
    const parent = base ?? await git.resolveRef({ fs, dir, ref: project.branch });

    // The state the approval was given for, read from the git store with a token of this Governor's own: its tree is the change.
    const at = `refs/brain/${task.root_id}/${stateCommit}`;
    const grant = signStoreGrant({ workspaceId: task.workspace_id, goalId: task.root_id, attemptId: attempt.id, expiresAt: Math.floor(gov.clock.nowMs() / 1000) + 600 }, gov.store.privateKeyPem);
    const url = `${gov.store.url}/${task.workspace_id}/${project.name}.git`;
    await git.addRemote({ fs, dir, remote: "store", url, force: true });
    await git.fetch({ fs, http, dir, remote: "store", url, ref: at, remoteRef: at, singleBranch: true, tags: false, headers: { authorization: `Basic ${Buffer.from(`x-access-token:${grant}`).toString("base64")}` } })
      .catch((e: unknown) => { throw new ToolRefusal(`The state ${stateCommit.slice(0, 12)} of the change could not be read from the git store: ${e instanceof Error ? e.message : "it did not answer"}`); });
    // A commit is named by its content: the one that arrived under that name is the state the approval was given for.
    const { commit: state } = await git.readCommit({ fs, dir, oid: stateCommit }).catch(() => { throw new ToolRefusal(`The git store does not hold the state ${stateCommit.slice(0, 12)} the approval was given for`); });
    const now = Math.floor(gov.clock.nowMs() / 1000);
    const who = { name: "Brain", email: "brain@localhost", timestamp: now, timezoneOffset: 0 };
    const commit = await git.writeCommit({ fs, dir, commit: { message: `${input.title}\n\n${input.body}\n`, tree: state.tree, parent: [parent], author: who, committer: who } });
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: commit, force: true });
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
      append(gov.db, { type: "pullRequest.opened", workspaceId: task.workspace_id, subject: `task:${task.id}`, payload: { ...opened, project: project.name, commit, stateCommit, patchDigest } as JsonValue, actor: { kind: "agent", id: attempt.agent, attemptId: attempt.id } });
    });
    return opened;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
