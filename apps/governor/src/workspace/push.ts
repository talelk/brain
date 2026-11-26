import { secretName, type FolderPush, gitAuthorization } from "@brain/contracts";
import git from "isomorphic-git";
import fs from "node:fs";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { httpOver } from "../integrations/pull-request";
import { readSecret } from "../trust/secrets";
import { getWorkspace, manifestOf, workspaceDir } from "./store";

/**
 * The workspace folder's git remote (docs/architecture.md, "The folder's remote"): after a folder is committed and its snapshot activated, the
 * Governor pushes the branch to `[git] remote`, in the background. A push never blocks or fails what committed it; its result is an audit event
 * (`workspace.pushed`, `workspace.push_failed`) that Settings and Health show. Never forced: a remote that has moved on refuses, and says so.
 */
const PUSH_TIMEOUT_MS = 60_000;

/** The text of an error with anything that could be a secret or a password in an address taken out. */
function scrub(text: string, secrets: readonly string[]): string {
  const hidden = secrets.filter((value) => value.length >= 4).reduce((shown, value) => shown.split(value).join("[secret]"), text);
  return hidden.replace(/(https?:\/\/)[^\s/@]+@/gu, "$1").slice(0, 400);
}

const running = new Map<string, { again: boolean }>();
/** Asks for a push of the workspace's folder; pushes of one workspace run one at a time, and those asked meanwhile are one more push of the latest commit. */
export function pushFolderSoon(gov: Gov, workspaceId: string): void {
  setImmediate(() => {
    const busy = running.get(workspaceId);
    if (busy) { busy.again = true; return; }
    const state = { again: false };
    running.set(workspaceId, state);
    void (async () => {
      try {
        do { state.again = false; await pushFolder(gov, workspaceId); } while (state.again);
      } catch { /* a push that could not even be recorded changes nothing */ } finally { running.delete(workspaceId); }
    })();
  });
}

async function pushFolder(gov: Gov, workspaceId: string): Promise<void> {
  let workspace;
  try { workspace = getWorkspace(gov.db, workspaceId); } catch { return; }
  const manifest = manifestOf(gov, workspace.snapshotDigest);
  const remote = manifest.git;
  if (!remote) return;
  const dir = workspaceDir(gov, workspace.slug);
  const credential = remote.credential ?? manifest.github?.credential;
  const token = credential ? readSecret(gov, workspaceId, secretName(credential)) : undefined;
  let commit = "";
  let problem: string | undefined;
  try {
    commit = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const branch = (await git.currentBranch({ fs, dir })) ?? "main";
    const headers = token ? { authorization: gitAuthorization(token) } : {};
    const send: typeof fetch = (input, init) => gov.fetch(input, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    const pushed = await git.push({ fs, http: httpOver(send), dir, url: remote.remote, ref: branch, remoteRef: `refs/heads/${branch}`, force: false, headers });
    if (!pushed.ok) problem = pushed.error ?? "the remote refused the push";
  } catch (e) {
    problem = e instanceof Error ? e.message : "the push failed";
  }
  const where = remote.remote.replace(/^(https?:\/\/)[^/@]*@/u, "$1");
  tx(gov.db, () => append(gov.db, {
    type: problem === undefined ? "workspace.pushed" : "workspace.push_failed", workspaceId, subject: `workspace:${workspaceId}`,
    payload: { commit, remote: where, ...(problem !== undefined ? { message: scrub(problem, token ? [token, ...token.split(":")] : []) } : {}) }, actor: SYSTEM,
  }));
}

/** The last push of the workspace's folder, from the audit log; null when it has none. */
export function lastPush(gov: Gov, workspaceId: string): FolderPush | null {
  const row = gov.db.prepare("SELECT type, payload_json AS payload, created_at_ms AS at FROM events WHERE workspace_id=? AND type IN ('workspace.pushed','workspace.push_failed') ORDER BY seq DESC LIMIT 1").get(workspaceId) as { type: string; payload: string; at: number } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as { commit?: string; message?: string };
  return { ok: row.type === "workspace.pushed", atMs: row.at, commit: payload.commit ?? "", message: payload.message ?? "" };
}
