import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog } from "@talelk/newui-molecules";
import {
  beginDecision, beginRecovery, returnToReview, settleDecision,
  type ApprovalIntent, type ApprovalOutcome, type ApprovalState,
} from "../approval-controller";

export function ApprovalReview(props: {
  active: boolean;
  requireTwoFactor?: boolean;
  approvalId: string;
  targetLabel: string;
  exactContent: string;
  subjectDigest: string;
  version: number;
  fresh: boolean;
  createIdempotencyKey: () => string;
  verifyIdentity: (approvalId: string, subjectDigest: string, code: string) => Promise<string>;
  submitDecision: (intent: ApprovalIntent, stepUpEvidenceId: string) => Promise<ApprovalOutcome>;
  checkDecision: (intent: ApprovalIntent) => Promise<ApprovalOutcome>;
}) {
  const [open, setOpen] = createSignal(false);
  const [note, setNote] = createSignal("");
  const [state, setState] = createSignal<ApprovalState>({ status: "review" });
  const [code, setCode] = createSignal("");
  const [verifying, setVerifying] = createSignal(false);
  const [identityError, setIdentityError] = createSignal("");
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const snapshot = () => ({ approvalId: props.approvalId, subjectDigest: props.subjectDigest, expectedVersion: props.version, targetLabel: props.targetLabel, exactContent: props.exactContent });
  const [reviewed, setReviewed] = createSignal(snapshot());
  const busy = () => verifying() || state().status === "submitting" || state().status === "checking";
  createEffect(() => { if (!props.active && !busy()) setOpen(false); });
  const sameProposal = () => reviewed().approvalId === props.approvalId && reviewed().subjectDigest === props.subjectDigest && reviewed().expectedVersion === props.version;
  const canSubmit = () => state().status === "review" && props.fresh && sameProposal();
  const canReviewAgain = () => state().status === "stale" || state().status === "denied";
  const noteId = createUniqueId();
  function openReview() {
    if (state().status === "review") setReviewed(snapshot());
    setOpen(true);
  }
  function reviewCurrent() {
    if (canReviewAgain()) setState(returnToReview(state()));
    if (state().status === "review") setReviewed(snapshot());
  }
  async function submit(decision: "approve" | "reject" | "request-changes" = "approve") {
    if (!canSubmit() || busy() || (decision === "approve" && props.requireTwoFactor && !/^\d{6}$/u.test(code()))) return;
    let proof: string;
    setVerifying(true); setIdentityError("");
    const entered = code(); setCode("");
    try { proof = decision === "approve" ? await props.verifyIdentity(reviewed().approvalId, reviewed().subjectDigest, entered) : ""; }
    catch (error) { setIdentityError(error instanceof Error ? error.message : "Verify your identity again."); return; }
    finally { setVerifying(false); }
    if (disposed || !canSubmit()) return;
    const next = beginDecision(state(), reviewed(), note(), props.createIdempotencyKey(), decision);
    setState(next);
    if (next.status !== "submitting") return;
    let outcome: ApprovalOutcome = "pending";
    try { outcome = await props.submitDecision(next.intent, proof); } catch { /* recover original request */ }
    setState(settleDecision(next, outcome));
  }
  async function check() {
    if (state().status !== "unknown") return;
    const next = beginRecovery(state());
    setState(next);
    if (next.status !== "checking") return;
    let outcome: ApprovalOutcome = "pending";
    try { outcome = await props.checkDecision(next.intent); } catch { /* retain original intent */ }
    setState(settleDecision(next, outcome));
  }
  const message = () => ({
    review: sameProposal() ? "" : "Proposal changed. Review the current proposal.",
    submitting: "Recording the decision.", checking: "Checking the original decision.",
    unknown: "Decision outcome uncertain. Check the original decision before submitting again.",
    confirmed: "Decision recorded. View the current approval and execution status.",
    stale: "Proposal changed. Review the current proposal.",
    denied: "Decision denied. Review authorization and the current proposal.",
  })[state().status];
  return <>
    <Button size="lg" variant="solid" theme="blue" iconLeft="lucide-shield-check" disabled={!props.active || !props.fresh} onClick={openReview}>Review action</Button>
    <Dialog.Root open={open()} onOpenChange={setOpen} dismissible={!busy()}>
      <Dialog.Content class="max-sm:fixed max-sm:inset-0 max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <Dialog.Header><Dialog.Title>Authorize action</Dialog.Title><Dialog.Description>{reviewed().targetLabel} · the decision binds this exact content and version.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
          <div><p class="mb-2 text-caption font-medium text-ink-gray-7">Exact proposal</p><pre class="brain-readable max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-card border border-outline-gray-1 bg-surface-gray-1 p-card-pad text-caption">{reviewed().exactContent}</pre></div>
          <Textarea id={noteId} label="Decision note" value={note()} description="Required to reject or request changes; optional for approval." disabled={state().status !== "review"} onInput={(event) => setNote(event.currentTarget.value)} />
          <Show when={props.requireTwoFactor}><TextInput label="Authenticator code" description="Six digits from your enrolled authenticator." autocomplete="one-time-code" inputmode="numeric" maxlength={6} pattern="[0-9]{6}" value={code()} onInput={(event) => setCode(event.currentTarget.value)} disabled={busy() || state().status !== "review"} /></Show>
          <Show when={identityError()}><Alert theme="red" variant="outline" title="Identity verification failed" description={identityError()} /></Show>
          <p role="status" aria-live="polite" class="min-h-5 text-interface text-ink-gray-7">{message()}</p>
        </div>
        <Dialog.Footer class="flex-wrap justify-end border-t border-outline-gray-1 pt-4">
          <Button size="lg" variant="outline" onClick={() => setOpen(false)} disabled={busy()}>Back</Button>
          <Button size="lg" variant="outline" onClick={reviewCurrent} disabled={busy() || !(canReviewAgain() || (state().status === "review" && !sameProposal()))}>Review current proposal</Button>
          <Button size="lg" variant="outline" onClick={check} loading={state().status === "checking"} disabled={state().status !== "unknown"}>Check decision</Button>
          <Button size="lg" variant="outline" onClick={() => void submit("request-changes")} disabled={!canSubmit() || busy() || !note().trim()}>Request changes</Button>
          <Button size="lg" variant="outline" onClick={() => void submit("reject")} disabled={!canSubmit() || busy() || !note().trim()} theme="red">Reject</Button>
          <Button size="lg" variant="solid" theme="blue" onClick={() => void submit()} loading={busy()} disabled={!canSubmit() || busy() || (!!props.requireTwoFactor && !/^\d{6}$/u.test(code()))}>{props.requireTwoFactor ? "Verify identity and approve" : "Approve exact action"}</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
