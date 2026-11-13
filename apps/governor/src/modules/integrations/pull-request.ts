import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import http from "isomorphic-git/http/node";
import { add, branch, checkout, clone, commit, push } from "isomorphic-git";
import fs from "node:fs";
import type { GitCredentialMaterial } from "./crypto";

/**
 * Opening a pull request (ADR 0024): push a new branch with the proposed files over the Git connection's own credentials, then ask the
 * hosting provider's REST API to open the request. The credentials stay in the Governor; the model sees the address of the new request.
 */
export interface ProposedFile { readonly path: string; readonly content: string }

export interface PullRequestApi {
  open(input: { remoteUrl: string; credentials: GitCredentialMaterial; base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }>;
}

const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024;

/** Paths the request may write: relative, inside the repository, never Git's own folder. Throws a plain reason. */
export function checkProposedFiles(files: readonly ProposedFile[]): void {
  if (files.length === 0 || files.length > MAX_FILES) throw new Error(`a pull request carries 1 to ${MAX_FILES} files`);
  for (const file of files) {
    const clean = normalize(file.path);
    if (!file.path || file.path.startsWith("/") || clean.startsWith("..") || clean.split("/").includes("..") || clean.split("/").includes(".git") || file.path.includes("\0")) throw new Error(`the path ${file.path.slice(0, 80)} is outside the repository`);
    if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) throw new Error(`${file.path} is larger than ${MAX_FILE_BYTES / 1024} KiB`);
  }
}

/** A branch of the proposed changes, pushed with the connection's credentials. Returns the commit. */
export async function pushProposalBranch(remoteUrl: string, credentials: GitCredentialMaterial, input: { base: string; head: string; message: string; files: readonly ProposedFile[] }): Promise<{ commitOid: string }> {
  checkProposedFiles(input.files);
  const auth = credentials.token ? { username: credentials.username || "oauth2", password: credentials.token } : undefined;
  const onAuth = auth ? { onAuth: () => auth } : {};
  const dir = mkdtempSync(join(tmpdir(), "brain-git-pr-"));
  try {
    await clone({ fs, http, dir, url: remoteUrl, ref: input.base, singleBranch: true, ...onAuth });
    await branch({ fs, dir, ref: input.head });
    await checkout({ fs, dir, ref: input.head });
    for (const file of input.files) {
      const path = join(dir, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, "utf8");
      await add({ fs, dir, filepath: file.path });
    }
    const now = Math.floor(Date.now() / 1000);
    const author = { name: "Brain", email: "brain@localhost", timestamp: now, timezoneOffset: 0 };
    const commitOid = await commit({ fs, dir, message: input.message, author, committer: author });
    const result = await push({ fs, http, dir, url: remoteUrl, ref: input.head, remoteRef: input.head, ...onAuth });
    if (!result.ok) throw new Error(result.error ?? "the Git server refused the branch");
    return { commitOid };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repositoryPath(remoteUrl: string): { origin: string; host: string; path: string } {
  const url = new URL(remoteUrl);
  return { origin: url.origin, host: url.hostname, path: url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "") };
}

async function expectJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

/** GitHub (github.com) or a GitLab-style host (any other address); the provider is read from the remote's address, never from the model. */
export class HostedPullRequestApi implements PullRequestApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async open(input: { remoteUrl: string; credentials: GitCredentialMaterial; base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const { origin, host, path } = repositoryPath(input.remoteUrl);
    const token = input.credentials.token ?? "";
    if (host === "github.com") {
      const answer = await expectJson(await this.fetchImpl(`https://api.github.com/repos/${path}/pulls`, {
        method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json", accept: "application/vnd.github+json", "user-agent": "Brain", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body }),
      }), "GitHub");
      return { number: Number(answer["number"]), url: String(answer["html_url"] ?? "") };
    }
    const answer = await expectJson(await this.fetchImpl(`${origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", ...(token ? { "private-token": token } : {}) },
      body: JSON.stringify({ source_branch: input.head, target_branch: input.base, title: input.title, description: input.body }),
    }), "the Git host");
    return { number: Number(answer["iid"]), url: String(answer["web_url"] ?? "") };
  }
}
