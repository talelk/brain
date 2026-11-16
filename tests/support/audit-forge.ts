import { auditChainDigest, auditGenesis, domainDigest, type AuditEventRecord, type AuditExportInput, type JsonValue } from "../../packages/contracts/src/index";

/**
 * The attacker's side of the audit tests: someone who can edit an exported log AND recompute every digest after the edit (so the chain
 * itself still links). What they cannot do is sign as a runner, which is what the receipt check holds them to.
 */
export function chainOf(input: AuditExportInput, scope: string): AuditEventRecord[] {
  const chain = input.chains.find((c) => c.scope === scope);
  if (!chain) throw new Error(`no chain ${scope}`);
  return [...chain.events].map((e) => ({ ...e }));
}

/** Recomputes payload digests, positions and links of `events` from the first one, as a forger with the whole log would. */
export function rechain(organizationId: string, scope: string, events: readonly AuditEventRecord[]): AuditEventRecord[] {
  let prev = auditGenesis(organizationId, scope);
  return events.map((e, index) => {
    const payloadDigest = domainDigest("brain:event:v1", JSON.parse(e.payloadJson) as JsonValue);
    const chainSeq = index + 1;
    const next = { ...e, payloadDigest, chainSeq, prevDigest: prev };
    const chainDigest = auditChainDigest(prev, chainSeq, next);
    prev = chainDigest;
    return { ...next, chainDigest };
  });
}

export const withPayload = (e: AuditEventRecord, edit: (payload: Record<string, unknown>) => void): AuditEventRecord => {
  const payload = JSON.parse(e.payloadJson) as Record<string, unknown>;
  edit(payload);
  return { ...e, payloadJson: JSON.stringify(payload) };
};

/** An export that holds `control` (re-chained) as the control log, and nothing else. */
export function exportWith(input: AuditExportInput, control: readonly AuditEventRecord[]): AuditExportInput {
  return { organizationId: input.organizationId, keys: input.keys, chains: [{ scope: "control", events: rechain(input.organizationId, "control", control), checkpoints: [] }] };
}
