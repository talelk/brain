import type { TestWorld } from "../helpers";
import { DIGEST_A } from "../helpers";

/** A pending approval for one exact call, requested through the `approval.request` command as the workspace owner. Returns its id. */
export async function requestApproval(w: TestWorld, key: string, summary?: string, identity = key): Promise<string> {
  const subject = {
    organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: `target-${identity}`, environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: summary ? { summary } : {}, expiresAt: expiry(identity), nonce: `nonce-${identity}`,
  };
  const { receipt } = await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "approval.request", workspaceId: w.workspaceId, idempotencyKey: key, payload: { subject },
  } as never, key);
  return (receipt as { resourceId?: string }).resourceId ?? "";
}

/** The same identity asks for the same exact call, so a repeated request is the same approval. */
const expiries = new Map<string, string>();
const expiry = (identity: string): string => {
  const known = expiries.get(identity) ?? new Date(Date.now() + 3_600_000).toISOString();
  expiries.set(identity, known);
  return known;
};
