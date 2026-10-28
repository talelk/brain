// Pure reference controller; the Governor remains authoritative for every result.
export interface ApprovalProposal {
  readonly approvalId: string;
  readonly subjectDigest: string;
  readonly expectedVersion: number;
}
export interface ApprovalIntent extends ApprovalProposal {
  readonly idempotencyKey: string;
  readonly note: string;
}
export type ApprovalOutcome = 'confirmed' | 'pending' | 'stale' | 'denied';
export type ApprovalState =
  | { readonly status: 'review' }
  | { readonly status: 'submitting' | 'unknown' | 'checking' | 'confirmed' | 'stale' | 'denied'; readonly intent: ApprovalIntent };

export function beginDecision(state: ApprovalState, proposal: ApprovalProposal, note: string, key: string): ApprovalState {
  if (state.status !== 'review') throw new Error('Decision already captured; recover or explicitly review a new proposal');
  if (!key) throw new Error('An idempotency key is required');
  return { status: 'submitting', intent: Object.freeze({ approvalId: proposal.approvalId,
    subjectDigest: proposal.subjectDigest, expectedVersion: proposal.expectedVersion, note, idempotencyKey: key }) };
}
export function beginRecovery(state: ApprovalState): ApprovalState {
  if (state.status !== 'unknown') throw new Error('Only an uncertain decision can be checked');
  return { status: 'checking', intent: state.intent };
}
export function settleDecision(state: ApprovalState, outcome: ApprovalOutcome): ApprovalState {
  if (state.status !== 'submitting' && state.status !== 'checking') throw new Error('No decision request is in progress');
  return { status: outcome === 'pending' ? 'unknown' : outcome, intent: state.intent };
}
export function returnToReview(state: ApprovalState): ApprovalState {
  if (state.status !== 'stale' && state.status !== 'denied') throw new Error('Resolve the original request before starting another');
  return { status: 'review' };
}
