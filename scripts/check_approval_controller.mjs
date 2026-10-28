import assert from 'node:assert/strict';
import { beginDecision, beginRecovery, settleDecision, returnToReview } from '../examples/v1/web/approval-controller.ts';
const proposal = { approvalId: 'ap1', subjectDigest: 'digest-A', expectedVersion: 7 };
const submitting = beginDecision({ status: 'review' }, proposal, 'Keep my note', 'key-1');
assert.throws(() => beginDecision(submitting, proposal, 'changed', 'key-2'));
const unknown = settleDecision(submitting, 'pending');
assert.equal(unknown.status, 'unknown');
assert.throws(() => returnToReview(unknown));
const checking = beginRecovery(unknown);
assert.strictEqual(checking.intent, submitting.intent);
assert.deepEqual(checking.intent, { ...proposal, note: 'Keep my note', idempotencyKey: 'key-1' });
const confirmed = settleDecision(beginRecovery(settleDecision(checking, 'pending')), 'confirmed');
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.intent.idempotencyKey, 'key-1');
assert.throws(() => beginRecovery(confirmed));
assert.throws(() => beginDecision(confirmed, proposal, '', 'key-3'));
for (const outcome of ['stale', 'denied']) {
  const result = settleDecision(submitting, outcome);
  assert.equal(result.intent.note, 'Keep my note');
  const next = beginDecision(returnToReview(result), { ...proposal, subjectDigest: 'digest-B', expectedVersion: 8 }, result.intent.note, 'key-2');
  assert.equal(next.intent.subjectDigest, 'digest-B');
  assert.equal(next.intent.idempotencyKey, 'key-2');
}
assert.equal(Object.hasOwn(confirmed, 'effectApplied'), false);
console.log('Approval controller: timeout recovery, original key/note binding, duplicate prevention, stale/denied review and decision/effect separation passed');
