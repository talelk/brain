import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Collapsible, Dialog } from "@talelk/newui-molecules";
import { StatusIcon } from "../viz/StatusIcon";
import {
  beginDecision, beginRecovery, returnToReview, settleDecision,
  type ApprovalIntent, type ApprovalOutcome, type ApprovalState,
} from "../approval-controller";

/** Seconds left until `expiresAt`, measured on the server clock (`asOf`) plus the time since the page loaded; display only, never authority. */
export function createExpiryClock(expiresAt: () => string | undefined, asOf: () => string | undefined) {
  const loadedAt = Date.now();
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => setTick((n) => n + 1), 15_000);
  onCleanup(() => clearInterval(timer));
  return createMemo(() => {
    tick();
    const expiry = Date.parse(expiresAt() ?? "");
    if (!Number.isFinite(expiry)) return undefined;
    const server = Date.parse(asOf() ?? "");
    const now = Number.isFinite(server) ? server + (Date.now() - loadedAt) : Date.now();
    return Math.floor((expiry - now) / 1000);
  });
}

export function countdownLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "No expiry declared";
  if (seconds <= 0) return "Expired";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `Expires in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Expires in ${hours} h ${minutes % 60} min` : `Expires in ${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Live "Expires in 42 min" with a state icon; urgent under ten minutes. */
export function ExpiryCountdown(props: { expiresAt?: string; asOf?: string; class?: string }) {
  const seconds = createExpiryClock(() => props.expiresAt, () => props.asOf);
  const urgent = () => (seconds() ?? Infinity) < 600;
  const gone = () => (seconds() ?? 1) <= 0;
  return <span class={`inline-flex items-center gap-1 ${urgent() ? "font-medium text-ink-red-8" : ""} ${props.class ?? ""}`}>
    <StatusIcon state={gone() ? "cancelled" : "pending"} theme={gone() ? "red" : urgent() ? "amber" : "blue"} />
    <span>{countdownLabel(seconds())}</span>
  </span>;
}

export function ApprovalReview(props: {
  /** One plain sentence naming the effect; leads the dialog. */
  summary?: string;
  requestedBy?: string;
  expiresAt?: string;
  asOf?: string;
  active: boolean;
  class?: string;
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
  const snapshot = () => ({ approvalId: props.approvalId, subjectDigest: props.subjectDigest, expectedVersion: props.version, targetLabel: props.targetLabel, exactContent: props.exactContent, summary: props.summary });
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
    <Button class={props.class} variant="solid" theme="blue" iconLeft="lucide-shield-check" disabled={!props.active || !props.fresh} onClick={openReview}>Review action</Button>
    <Dialog.Root open={open()} onOpenChange={setOpen} dismissible={!busy()}>
      <Dialog.Content size="2xl" class="flex max-h-[calc(100dvh-2rem)] flex-col max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <Dialog.Header class="min-w-0"><Dialog.Title>Authorize action</Dialog.Title><Dialog.Description class="break-words [overflow-wrap:anywhere]">{reviewed().summary ?? reviewed().targetLabel}</Dialog.Description></Dialog.Header>
        <div class="my-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1">
          <Show when={props.requestedBy || props.expiresAt}><p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7"><Show when={props.requestedBy}><span>Asked by {props.requestedBy}</span></Show><ExpiryCountdown expiresAt={props.expiresAt} asOf={props.asOf} /></p></Show>
          <p class="text-interface text-ink-gray-7">Your decision binds this exact proposal, version {reviewed().expectedVersion}. Open the exact details to inspect it.</p>
          <Collapsible.Root class="min-w-0 rounded-control border border-outline-gray-1 p-card-pad-compact">
            <Collapsible.Trigger>Exact details</Collapsible.Trigger>
            <Collapsible.Content><div class="min-w-0 pt-2">
              <div class="mb-1.5 flex items-center justify-between gap-3"><p class="text-caption font-medium text-ink-gray-7">Exact proposal</p><span class="shrink-0 text-caption text-ink-gray-6">Version {reviewed().expectedVersion}</span></div>
              <pre class="brain-readable max-h-48 max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3 text-caption">{reviewed().exactContent}</pre>
            </div></Collapsible.Content>
          </Collapsible.Root>
          <Textarea id={noteId} label="Decision note" value={note()} description="Required to reject or request changes; optional for approval." disabled={state().status !== "review"} onInput={(event) => setNote(event.currentTarget.value)} rows={3} />
          <Show when={props.requireTwoFactor}><div class="rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3"><p class="mb-2 text-caption font-medium text-ink-gray-7">Identity confirmation</p><TextInput label="Authenticator code" description="Six digits, verified for this exact subject." autocomplete="one-time-code" inputmode="numeric" maxlength={6} pattern="[0-9]{6}" value={code()} onInput={(event) => setCode(event.currentTarget.value)} disabled={busy() || state().status !== "review"} /></div></Show>
          <Show when={identityError()}><Alert theme="red" variant="outline" title="Identity verification failed" description={identityError()} /></Show>
          <p role="status" aria-live="polite" class="min-h-5 break-words text-interface text-ink-gray-7">{message()}</p>
        </div>
        <Dialog.Footer class="grid grid-cols-2 gap-2 border-t border-outline-gray-1 pt-3 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
          <Button size="sm" class="col-span-2 sm:me-auto" variant="outline" onClick={() => setOpen(false)} disabled={busy()}>Back</Button>
          <Show when={canReviewAgain() || (state().status === "review" && !sameProposal())}><Button size="sm" class="col-span-2" variant="outline" onClick={reviewCurrent} disabled={busy()}>Review current proposal</Button></Show>
          <Show when={state().status === "unknown" || state().status === "checking"}><Button size="sm" class="col-span-2" variant="outline" onClick={check} loading={state().status === "checking"} disabled={state().status !== "unknown"}>Check decision</Button></Show>
          <Button size="sm" variant="outline" onClick={() => void submit("request-changes")} disabled={!canSubmit() || busy() || !note().trim()}>Request changes</Button>
          <Button size="sm" variant="outline" onClick={() => void submit("reject")} disabled={!canSubmit() || busy() || !note().trim()} theme="red">Reject</Button>
          <Button size="sm" class="col-span-2" variant="solid" theme="blue" onClick={() => void submit()} loading={busy()} disabled={!canSubmit() || busy() || (!!props.requireTwoFactor && !/^\d{6}$/u.test(code()))}>{props.requireTwoFactor ? "Verify identity and approve" : "Approve exact action"}</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
