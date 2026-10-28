import { createSignal, createUniqueId, type JSX } from 'solid-js';
import { Button, Textarea } from '@talelk/newui-atoms';
import { Dialog } from '@talelk/newui-molecules';
import { AppShell } from '@talelk/newui-templates';
import {
  beginDecision, beginRecovery, returnToReview, settleDecision,
  type ApprovalIntent, type ApprovalOutcome, type ApprovalState,
} from './approval-controller';

// G01 must compile/render against installed NewUI. Callbacks use real Governor APIs.
// checkDecision looks up the original key under current authorization.
// Absent or still-ambiguous responses return pending, never assumed success.
export function ExactApproval(props: {
  approvalId: string;
  targetLabel: string;
  exactContent: string;
  subjectDigest: string;
  version: number;
  fresh: boolean;
  createIdempotencyKey: () => string;
  submitDecision: (intent: ApprovalIntent) => Promise<ApprovalOutcome>;
  checkDecision: (intent: ApprovalIntent) => Promise<ApprovalOutcome>;
}) {
  const [open, setOpen] = createSignal(false);
  const [note, setNote] = createSignal('');
  const [state, setState] = createSignal<ApprovalState>({ status: 'review' });
  const snapshot = () => ({ approvalId: props.approvalId, subjectDigest: props.subjectDigest,
    expectedVersion: props.version, targetLabel: props.targetLabel, exactContent: props.exactContent });
  const [reviewed, setReviewed] = createSignal(snapshot());
  const busy = () => state().status === 'submitting' || state().status === 'checking';
  const sameProposal = () => reviewed().approvalId === props.approvalId &&
    reviewed().subjectDigest === props.subjectDigest && reviewed().expectedVersion === props.version;
  const canSubmit = () => state().status === 'review' && props.fresh && sameProposal();
  const canReviewAgain = () => state().status === 'stale' || state().status === 'denied';
  const noteId = createUniqueId();
  function openReview() {
    if (state().status === 'review') setReviewed(snapshot());
    setOpen(true);
  }
  function reviewCurrent() {
    if (canReviewAgain()) setState(returnToReview(state()));
    if (state().status === 'review') setReviewed(snapshot());
    // Keep the note; create a new key only for a new explicit submission.
  }
  async function submit() {
    if (!canSubmit()) return;
    const next = beginDecision(state(), reviewed(), note(), props.createIdempotencyKey());
    setState(next);
    if (next.status !== 'submitting') return;
    let outcome: ApprovalOutcome = 'pending';
    try { outcome = await props.submitDecision(next.intent); } catch { /* recover original request */ }
    setState(settleDecision(next, outcome));
  }
  async function check() {
    if (state().status !== 'unknown') return;
    const next = beginRecovery(state());
    setState(next);
    if (next.status !== 'checking') return;
    let outcome: ApprovalOutcome = 'pending';
    try { outcome = await props.checkDecision(next.intent); } catch { /* retain original intent */ }
    setState(settleDecision(next, outcome));
  }
  const message = () => ({ review: sameProposal() ? '' : 'Proposal changed. Review the current proposal.',
    submitting: 'Recording the decision.', checking: 'Checking the original decision.',
    unknown: 'Decision outcome uncertain. Check the original decision before submitting again.',
    confirmed: 'Decision recorded. View the current approval and execution status.', stale: 'Proposal changed. Review the current proposal.',
    denied: 'Decision denied. Review authorization and the current proposal.' })[state().status];
  return <>
    <Button onClick={openReview} class="min-h-11">Review action</Button>
    <Dialog.Root open={open()} onOpenChange={setOpen} dismissible={!busy()}>
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>Authorize action</Dialog.Title>
          <Dialog.Description>{reviewed().targetLabel}</Dialog.Description>
        </Dialog.Header>
        <pre class="whitespace-pre-wrap break-words">{reviewed().exactContent}</pre>
        <Textarea id={noteId} label="Decision note" value={note()} disabled={state().status !== 'review'}
          onInput={e => setNote(e.currentTarget.value)} />
        <p role="status" aria-live="polite">{message()}</p>
        <Dialog.Footer>
          <Button onClick={() => setOpen(false)} disabled={busy()} class="min-h-11">Back</Button>
          <Button onClick={reviewCurrent} disabled={busy() || !(canReviewAgain() || (state().status === 'review' && !sameProposal()))}
            class="min-h-11">Review current proposal</Button>
          <Button onClick={check} loading={state().status === 'checking'} disabled={state().status !== 'unknown'}
            class="min-h-11">Check decision</Button>
          <Button onClick={submit} loading={state().status === 'submitting'} disabled={!canSubmit()}
            class="min-h-11">Verify identity and approve</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}

export function BrainFrame(props: { title: string; workspace: JSX.Element; children: JSX.Element }) {
  return <AppShell brand="Keyrus Brain" title={props.title} tenant={props.workspace}
    navLabel="Workspace navigation">{props.children}</AppShell>;
}
