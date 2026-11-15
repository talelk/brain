import type { ActorContext } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { HostedPullRequestApi } from "../../apps/governor/src/modules/integrations/pull-request";
import { recordPullRequest } from "../../apps/governor/src/modules/missions/index";
import { createGitHttpBackend } from "./git-http-backend";

const DIGEST = `sha256:${"a".repeat(64)}`;
export const PULL_REQUEST_URL = "https://git.example.test/demo/pull/7";
export const PULL_REQUEST_TOKEN = "demo-pr-secret-token-0123456789";

/**
 * A pull request an approved change opened for one task of the seeded workspace, for the screens that show it. The connection and the
 * approval go through commands; the opening itself (clone, push, provider call) is the one thing a browser fixture has no runner to do,
 * so the record is written through the same function the Governor calls when the provider answers. The provider's API is the only thing
 * stubbed: `provider.state` is what a refresh finds, and `provider.fail` makes it answer with an error.
 */
export async function seedPullRequest(brain: Brain, actor: ActorContext, workspaceId: string, input: { runId: string; key: string }): Promise<{
  approvalId: string; pullRequestId: string; provider: { state: "open" | "closed"; merged: boolean; fail: boolean }; cleanup: () => Promise<void>;
}> {
  const remote = await createGitHttpBackend();
  const provider = { state: "open" as "open" | "closed", merged: false, fail: false };
  brain.integrations.usePullRequestApi(new HostedPullRequestApi((async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return provider.fail ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ number: 7, state: provider.state, merged: provider.merged }), { status: 200 });
    return new Response(JSON.stringify({ number: 7, html_url: PULL_REQUEST_URL }), { status: 201 });
  }) as unknown as typeof fetch));
  const run = async (commandType: string, key: string, payload: Record<string, unknown>, scoped: boolean): Promise<string> => {
    const { receipt } = await brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, ...(scoped ? { workspaceId } : {}), idempotencyKey: key, payload } as never, key);
    if (!receipt.accepted) throw new Error(`pull request seed: ${commandType} was refused`);
    return receipt.resourceId ?? "";
  };
  const connectionId = await run("integration.connect", `${input.key}-connect`, { provider: "github-enterprise", name: "Demo repo", repositoryUrl: remote.remote, username: "brain-bot", token: PULL_REQUEST_TOKEN }, false);
  await brain.integrations.verifyPending();
  await run("integration.bind", `${input.key}-bind`, { connectionId, workspaceId, kind: "project", repositoryKey: remote.remote, access: "write" }, true);
  await brain.integrations.verifyPending();

  // The approval the change was opened under, as an agent's proposal names it, then decided.
  const now = brain.store.now();
  const title = "Raise the demo-app memory limit";
  const approvalId = await run("approval.request", `${input.key}-approval`, { subject: {
    organizationId: actor.organizationId, workspaceId, operation: "effect.git.open-pr", tool: { id: "git.open-pr", digest: DIGEST }, inputDigest: DIGEST,
    target: { targetId: "tool:git.open-pr", environmentId: "production", preconditionDigest: DIGEST }, artifactDigest: DIGEST, policyDigest: DIGEST, configDigest: DIGEST,
    effectBounds: { summary: `Open a pull request "${title}" from branch brain/raise-demo-app-memory with 1 changed file(s)`, arguments: { title, branch: "brain/raise-demo-app-memory", files: [{ path: "docs/demo-app/limits.md", content: "memory: 768m\n" }] }, once: true },
    expiresAt: new Date(now + 3600_000).toISOString(), nonce: `${input.key}-approval`,
  } }, true);
  brain.store.control.prepare("UPDATE approval_requests SET state='approved', version=version+1 WHERE id=?").run(approvalId);

  const { pullRequestId } = recordPullRequest(brain.store, brain.store.workspaceDb(workspaceId, actor.organizationId), {
    organizationId: actor.organizationId, workspaceId, approvalId, invocationId: `inv-${approvalId}`, runId: input.runId, title,
    opened: { url: PULL_REQUEST_URL, number: 7, branch: "brain/raise-demo-app-memory", base: "main", commit: "b".repeat(40), provider: "github-enterprise", connectionId, repositoryKey: remote.remote },
  });
  return { approvalId, pullRequestId, provider, cleanup: () => remote.cleanup() };
}
