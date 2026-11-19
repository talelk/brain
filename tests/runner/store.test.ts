import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { signStoreGrant, STORE_RETENTION_ATTEMPT } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { credentialEnv } from "../../apps/runner/src/working-copy";
import { bareRepository, git, tempDir, writeFiles } from "./git-repo";
import { testStore } from "./store";

/** The git store (docs/architecture.md, section 8): who may read, and the one ref a token may create. */
const store = await testStore();
const ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
// Asynchronous: the store runs in this very process, which a blocked call would stop from answering.
const exec = promisify(execFile);
const run = async (cwd: string, token: string, repo: string, ...args: string[]): Promise<{ ok: boolean; out: string }> => {
  try { return { ok: true, out: (await exec("git", args, { cwd, env: { ...ENV, ...credentialEnv(repo, token) } })).stdout }; }
  catch (error) { return { ok: false, out: String((error as { stderr?: unknown }).stderr ?? error) }; }
};

describe("the git store", () => {
  const origin = bareRepository({ "a.txt": "one\n" });
  const clone = tempDir("clone");
  git(clone, "clone", "--quiet", origin.repo, "work");
  const work = join(clone, "work");
  writeFiles(work, { "b.txt": "two\n" });
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "-m", "state");
  const first = git(work, "rev-parse", "HEAD");
  const repo = `${store.url}/ws1/app.git`;
  const push = (token: string, ref: string, extra: string[] = []): Promise<{ ok: boolean; out: string }> => run(work, token, repo, "push", "--quiet", ...extra, repo, `HEAD:${ref}`);

  it("lets a token create the ref named by a commit under its own goal, and read it from another clone", async () => {
    expect((await push(store.offer("ws1", "g1", "a1").token, `refs/brain/g1/${first}`)).ok).toBe(true);
    const reader = tempDir("reader");
    git(reader, "init", "--quiet", "--bare", "mirror.git");
    // Any attempt of the workspace reads it, whatever its own grant names.
    const fetched = await run(join(reader, "mirror.git"), store.offer("ws1", "g2", "a2").token, repo, "fetch", "--quiet", repo, `+refs/brain/g1/${first}:refs/heads/state`);
    expect(fetched.ok).toBe(true);
    expect(git(join(reader, "mirror.git"), "rev-parse", "refs/heads/state")).toBe(first);
  });

  it("refuses another goal's ref, a ref not named by its commit, a branch, a rewrite and a deletion", async () => {
    const mine = store.offer("ws1", "g1", "a3").token;
    expect((await push(mine, `refs/brain/g9/${first}`)).ok).toBe(false);
    expect((await push(mine, "refs/brain/g1/a3")).ok).toBe(false);
    expect((await push(mine, "refs/heads/main")).ok).toBe(false);
    writeFiles(work, { "c.txt": "three\n" });
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "-m", "again");
    // The ref of the first state does not take another commit, forced or not.
    expect((await push(mine, `refs/brain/g1/${first}`, ["--force"])).ok).toBe(false);
    expect((await run(work, mine, repo, "push", "--quiet", repo, `:refs/brain/g1/${first}`)).ok).toBe(false);
    expect((await push(mine, `refs/brain/g1/${git(work, "rev-parse", "HEAD")}`)).ok).toBe(true);
  });

  it("refuses a missing, forged, expired or other workspace's token", async () => {
    const forged = signStoreGrant({ workspaceId: "ws1", goalId: "g1", attemptId: "a5", expiresAt: Math.floor(Date.now() / 1000) + 3600 }, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    for (const token of ["", "garbage", forged, store.offer("ws1", "g1", "a5", Math.floor(Date.now() / 1000) - 10).token, store.offer("ws2", "g1", "a5").token]) {
      expect((await push(token, `refs/brain/g1/${first}`)).ok).toBe(false);
    }
  });

  it("forgets the states of a goal when its retention token asks, and for no other token", async () => {
    const kept = store.offer("ws1", "g7", "a7");
    const pushed = git(work, "rev-parse", "HEAD");
    expect((await push(kept.token, `refs/brain/g7/${pushed}`)).ok).toBe(true);
    const forget = (token: string, goal = "g7") => fetch(`${store.url}/ws1/_goals/${goal}`, { method: "DELETE", headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } });
    const grant = (workspaceId: string, goalId: string, attemptId: string) => signStoreGrant({ workspaceId, goalId, attemptId, expiresAt: Math.floor(Date.now() / 1000) + 300 }, store.privateKeyPem);
    // A token made for an attempt, one for another goal or workspace, and none at all are refused.
    expect([(await forget(kept.token)).status, (await forget(grant("ws1", "g8", STORE_RETENTION_ATTEMPT))).status, (await forget(grant("ws2", "g7", STORE_RETENTION_ATTEMPT))).status, (await forget("")).status]).toEqual([403, 403, 403, 401]);
    const refs = () => git(join(store.root, "repos", "ws1", "app.git"), "for-each-ref", "refs/brain/g7/");
    expect(refs()).toContain(pushed);
    const answer = await forget(grant("ws1", "g7", STORE_RETENTION_ATTEMPT));
    expect([answer.status, await answer.json()]).toEqual([200, { deleted: 1 }]);
    expect(refs()).toBe("");
    // Another goal's states are not touched.
    expect(git(join(store.root, "repos", "ws1", "app.git"), "for-each-ref", "refs/brain/g1/")).not.toBe("");
  });
});
