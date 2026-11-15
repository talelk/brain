import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import http from "isomorphic-git/http/node";
import { add, branch, checkout, clone, commit, push } from "isomorphic-git";
import fs from "node:fs";
import type { GitProvider, PullRequestState } from "@brain/contracts";
import type { GitCredentialMaterial } from "./crypto";
import { gitProviderLabel } from "./git-provider";

/**
 * Opening a pull request (ADR 0024): push a new branch with the proposed files over the Git connection's own credentials, then ask the
 * connection's Git provider's REST API to open the request. The credentials stay in the Governor; the model sees the address of the new request.
 */
export interface ProposedFile { readonly path: string; readonly content: string }

export interface PullRequestInput { provider: GitProvider; remoteUrl: string; credentials: GitCredentialMaterial; base: string; head: string; title: string; body: string }
export interface PullRequestLookup { provider: GitProvider; remoteUrl: string; credentials: GitCredentialMaterial; number: number }
export interface PullRequestApi {
  open(input: PullRequestInput): Promise<{ number: number; url: string }>;
  /** Where the request stands at the provider now (a read; nothing is changed there). */
  state(input: PullRequestLookup): Promise<PullRequestState>;
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

function repositoryPath(remoteUrl: string): { origin: string; path: string } {
  const url = new URL(remoteUrl);
  return { origin: url.origin, path: url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "") };
}

async function expectJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

/**
 * Opens the request through the API of the provider the owner chose for the connection (GitHub, GitHub Enterprise, GitLab, Gitea).
 * There is no guessing from the address and no fallback: a provider with no case here is refused.
 */
export class HostedPullRequestApi implements PullRequestApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async post(url: string, headers: Record<string, string>, body: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    return await expectJson(await this.fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), what);
  }

  private async get(url: string, headers: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    return await expectJson(await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(20_000), headers }), what);
  }

  async open(input: PullRequestInput): Promise<{ number: number; url: string }> {
    const opened = await this.openAt(input);
    // The address is what a person follows: an answer without one is not a usable request, however it was made.
    if (!/^https?:\/\//u.test(opened.url)) throw new Error(`${gitProviderLabel(input.provider)} did not return the address of the request`);
    return opened;
  }

  async state(input: PullRequestLookup): Promise<PullRequestState> {
    const { origin, path } = repositoryPath(input.remoteUrl);
    const token = input.credentials.token ?? "";
    const label = gitProviderLabel(input.provider);
    const number = encodeURIComponent(String(input.number));
    switch (input.provider) {
      case "github":
      case "github-enterprise":
      case "gitea": {
        const github = input.provider !== "gitea";
        const url = input.provider === "github" ? `https://api.github.com/repos/${path}/pulls/${number}` : github ? `${origin}/api/v3/repos/${path}/pulls/${number}` : `${origin}/api/v1/repos/${path}/pulls/${number}`;
        const headers = github ? { accept: "application/vnd.github+json", "user-agent": "Brain", ...(token ? { authorization: `Bearer ${token}` } : {}) } : (token ? { authorization: `token ${token}` } : {});
        const answer = await this.get(url, headers, label);
        if (answer["merged"] === true || (typeof answer["merged_at"] === "string" && answer["merged_at"])) return "merged";
        if (answer["state"] === "closed") return "closed";
        if (answer["state"] === "open") return "open";
        throw new Error(`${label} answered a pull request state Brain does not know`);
      }
      case "gitlab": {
        const answer = await this.get(`${origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests/${number}`, token ? { "private-token": token } : {}, label);
        // locked means the merge is in progress: not merged yet, so still open.
        if (answer["state"] === "merged") return "merged";
        if (answer["state"] === "closed") return "closed";
        if (answer["state"] === "opened" || answer["state"] === "locked") return "open";
        throw new Error(`${label} answered a merge request state Brain does not know`);
      }
      default: throw new Error(`pull requests are not supported for the Git provider "${String(input.provider).slice(0, 40)}"`);
    }
  }

  private async openAt(input: PullRequestInput): Promise<{ number: number; url: string }> {
    const { origin, path } = repositoryPath(input.remoteUrl);
    const token = input.credentials.token ?? "";
    const label = gitProviderLabel(input.provider);
    const proposal = { title: input.title, head: input.head, base: input.base, body: input.body };
    switch (input.provider) {
      case "github":
      case "github-enterprise": {
        const api = input.provider === "github" ? "https://api.github.com" : `${origin}/api/v3`;
        const answer = await this.post(`${api}/repos/${path}/pulls`, { accept: "application/vnd.github+json", "user-agent": "Brain", ...(token ? { authorization: `Bearer ${token}` } : {}) }, proposal, label);
        return { number: Number(answer["number"]), url: String(answer["html_url"] ?? "") };
      }
      case "gitea": {
        const answer = await this.post(`${origin}/api/v1/repos/${path}/pulls`, token ? { authorization: `token ${token}` } : {}, proposal, label);
        return { number: Number(answer["number"]), url: String(answer["html_url"] ?? "") };
      }
      case "gitlab": {
        const answer = await this.post(`${origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, token ? { "private-token": token } : {},
          { source_branch: input.head, target_branch: input.base, title: input.title, description: input.body }, label);
        return { number: Number(answer["iid"]), url: String(answer["web_url"] ?? "") };
      }
      default: throw new Error(`pull requests are not supported for the Git provider "${String(input.provider).slice(0, 40)}"`);
    }
  }
}

