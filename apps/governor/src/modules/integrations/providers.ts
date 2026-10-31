import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import http from "isomorphic-git/http/node";
import { add, clone, commit, listServerRefs, push, readBlob } from "isomorphic-git";
import fs from "node:fs";
import type { IntegrationRepository } from "@brain/contracts";
import type { SourceDoc } from "../configuration/compiler";
import type { GitCredentialMaterial } from "./crypto";

export interface RemoteSnapshot {
  repository: IntegrationRepository;
  refs: Record<string, string>;
}

export interface GitProtocolClient {
  discover(): Promise<RemoteSnapshot>;
  verifyRepository(repositoryKey: string): Promise<RemoteSnapshot>;
  publishFiles(documents: readonly SourceDoc[], message: string): Promise<{ commitOid: string; documents: SourceDoc[] }>;
}

function displayName(remoteUrl: string): string {
  const name = remoteUrl.replace(/\/$/u, "").split("/").at(-1) ?? remoteUrl;
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

export class IsomorphicGitClient implements GitProtocolClient {
  constructor(private readonly remoteUrl: string, private readonly credentials: GitCredentialMaterial) {}

  private auth() {
    return this.credentials.token ? { username: this.credentials.username || "oauth2", password: this.credentials.token } : undefined;
  }

  private async refs(forPush: boolean): Promise<Record<string, string>> {
    const auth = this.auth();
    const refs = await listServerRefs({ http, url: this.remoteUrl, forPush, protocolVersion: 1, ...(auth ? { onAuth: () => auth } : {}) });
    return Object.fromEntries(refs.map((entry) => [entry.ref, entry.oid]));
  }

  async discover(): Promise<RemoteSnapshot> {
    const refs = await this.refs(false);
    if (Object.keys(refs).length === 0) throw new Error("Git remote returned no refs");
    await this.refs(true);
    const defaultBranch = refs["refs/heads/main"] ? "main" : Object.keys(refs).find((ref) => ref.startsWith("refs/heads/"))?.slice("refs/heads/".length) ?? "main";
    const remoteId = refs.HEAD ?? refs[`refs/heads/${defaultBranch}`] ?? Object.values(refs)[0];
    return {
      repository: {
        repositoryKey: this.remoteUrl, displayName: displayName(this.remoteUrl), defaultBranch,
        ...(remoteId ? { remoteId } : {}), permissions: { read: true, write: true },
      },
      refs,
    };
  }

  async verifyRepository(repositoryKey: string): Promise<RemoteSnapshot> {
    if (repositoryKey !== this.remoteUrl) throw new Error("Git binding does not match the connection remote");
    return this.discover();
  }

  async publishFiles(documents: readonly SourceDoc[], message: string): Promise<{ commitOid: string; documents: SourceDoc[] }> {
    const dir = mkdtempSync(join(tmpdir(), "brain-git-publish-"));
    try {
      await clone({ fs, http, dir, url: this.remoteUrl, ref: "main", singleBranch: true });
      for (const document of documents) {
        const path = join(dir, document.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, document.text, "utf8");
        await add({ fs, dir, filepath: document.path });
      }
      const now = Math.floor(Date.now() / 1000);
      const author = { name: "Brain Studio", email: "brain@localhost", timestamp: now, timezoneOffset: 0 };
      const commitOid = await commit({ fs, dir, message, author, committer: author });
      const result = await push({ fs, http, dir, url: this.remoteUrl, ref: "main", remoteRef: "main" });
      if (!result.ok) throw new Error(result.error ?? "Git push was refused");
      const committed = await Promise.all(documents.map(async (document) => ({ path: document.path, text: new TextDecoder().decode(await readBlob({ fs, dir, oid: commitOid, filepath: document.path }).then((result) => result.blob)) })));
      return { commitOid, documents: committed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function protocolClient(remoteUrl: string, credentials: GitCredentialMaterial): GitProtocolClient {
  return new IsomorphicGitClient(remoteUrl, credentials);
}
