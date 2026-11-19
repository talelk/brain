import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { signStoreGrant } from "@brain/contracts";
import { startStore, type Store } from "../../apps/store/src/store";
import { git, tempDir, writeFiles } from "../runner/git-repo";
import type { Harness } from "./harness";

/** A git store for a core test, checking tokens with the public key the Governor writes in the data directory of the harness that is made after it, on that Governor's clock. */
export function startCoreStore(harness: () => Harness): Promise<Store & { readonly port: number }> {
  return startStore({ root: tempDir("store"), publicKeyPem: () => readFileSync(join(harness().dataDir, "store.pub"), "utf8"), nowSeconds: () => Math.floor(harness().governor.gov.clock.nowMs() / 1000) }, 0, "127.0.0.1");
}

/**
 * What a runner pushes to the git store for a change: the project at a commit with these files changed, as one commit whose tree is the change,
 * under the goal and named by its own id. Returns the commit.
 */
export async function pushState(harness: Harness, store: { readonly port: number }, at: { workspaceId: string; project: string; goalId: string; attemptId: string; repo: string }, files: Record<string, string>, base: string): Promise<string> {
  const dir = tempDir("state");
  git(dir, "clone", "--quiet", at.repo, "work");
  const work = join(dir, "work");
  git(work, "checkout", "--quiet", "--detach", base);
  writeFiles(work, files);
  git(work, "add", "--all");
  git(work, "-c", "user.name=Brain", "-c", "user.email=brain@localhost", "commit", "--quiet", "-m", "state");
  const sha = git(work, "rev-parse", "HEAD");
  const token = signStoreGrant({ workspaceId: at.workspaceId, goalId: at.goalId, attemptId: at.attemptId, expiresAt: Math.floor(harness.governor.gov.clock.nowMs() / 1000) + 600 }, harness.governor.gov.store!.privateKeyPem);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  // Asynchronous: the store runs in this very process.
  await promisify(execFile)("git", ["-C", work, "-c", `http.extraHeader=Authorization: Basic ${basic}`, "push", "--quiet", `http://127.0.0.1:${store.port}/${at.workspaceId}/${at.project}.git`, `HEAD:refs/brain/${at.goalId}/${sha}`], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null" } });
  return sha;
}
