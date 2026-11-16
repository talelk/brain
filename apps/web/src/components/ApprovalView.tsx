import { createSignal, For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button, Textarea } from "@talelk/newui-atoms";
import type { Approval, JsonValue } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { invalidate } from "../data/live";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { ago, dateTime, shortHash, show } from "../lib/format";
import { ArtifactDiff } from "./Diff";
import { Details, Failure } from "./bits";

const fields = (input: JsonValue): Array<[string, JsonValue]> => (input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [["input", input]]);

/**
 * One approval, showing exactly what the API says the approver is shown: the tool, its inputs, the task it is for and, for a pull request,
 * the diff that would be opened. The decision is sent with the digest of that subject, so a changed call cannot be approved by mistake.
 */
export function ApprovalView(props: { approval: Approval; diff?: "show" | "link"; href?: string }): JSX.Element {
  const place = usePlace();
  const [rejecting, setRejecting] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const decide = useAction(async (decision: "approve" | "reject") => {
    try {
      await command("approval.decide", { workspaceId: place.id(), approvalId: props.approval.id, decision, subjectDigest: props.approval.subjectDigest, reason: reason() });
    } catch (error) {
      invalidate(true);
      throw error;
    }
  });
  const approval = (): Approval => props.approval;
  const taskHref = (): string => place.to(`/tasks/${approval().taskId}`);
  return (
    <div class="flex flex-col gap-3">
      <p class="t-text text-ink">
        {t("approval.asks", { agent: approval().agent })} <code class="t-code code-ltr rounded-md bg-lilac px-1.5 py-0.5 font-medium">{approval().tool}</code>
        <span class="text-ink-2"> {t(`approval.effect.${approval().effect}`)}</span>
      </p>
      {/* The inputs are the call's own data, so they read left to right like code, whatever the language of the page. */}
      <dl class="code-ltr grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-xl bg-paper px-3.5 py-3 t-small">
        <For each={fields(approval().subject.input)}>
          {([name, value]) => (<><dt class="text-ink-3">{name}</dt><dd class="min-w-0 whitespace-pre-wrap break-words text-ink">{show(value)}</dd></>)}
        </For>
      </dl>
      <Show when={approval().subject.patchDigest}>
        {(digest) => (
          <Show when={props.diff === "show"} fallback={<p class="t-small text-ink-2">{t("approval.diff.link")} <A href={props.href ?? taskHref()} class="link">{t("approval.diff.open")}</A></p>}>
            <div><p class="mb-2 t-small font-medium text-ink-2">{t("approval.diff.title")}</p><ArtifactDiff digest={digest()} /></div>
          </Show>
        )}
      </Show>
      <Show when={approval().state === "pending"} fallback={
        <p class="t-small text-ink-2">
          {approval().standing ? t("approval.standing") : t(`approval.was.${approval().state}`, { name: approval().decidedBy?.name ?? "", when: approval().decidedAt ? dateTime(approval().decidedAt ?? 0) : "" })}
          <Show when={approval().reason}> {t("approval.reason", { reason: approval().reason ?? "" })}</Show>
        </p>
      }>
        <Show when={place.can("member")} fallback={<p class="t-small text-ink-2">{t("approval.viewer")}</p>}>
          <Show when={rejecting()}>
            <Textarea size="md" label={t("approval.reject.reason")} description={t("approval.reject.help")} value={reason()} onInput={(event) => setReason(event.currentTarget.value)} rows={2} autofocus />
          </Show>
          <Failure error={decide.error()} />
          <div class="flex flex-wrap items-center gap-2">
            <Show when={rejecting()} fallback={<>
              <Button variant="solid" theme="blue" size="md" loading={decide.busy()} onClick={() => void decide.run("approve")}>{approval().subject.patchDigest ? t("approval.approve.pr") : t("approval.approve")}</Button>
              <Button variant="outline" size="md" disabled={decide.busy()} onClick={() => setRejecting(true)}>{t("approval.reject")}</Button>
            </>}>
              <Button variant="solid" theme="red" size="md" loading={decide.busy()} onClick={() => void decide.run("reject")}>{t("approval.reject.confirm")}</Button>
              <Button variant="ghost" size="md" disabled={decide.busy()} onClick={() => setRejecting(false)}>{t("action.cancel")}</Button>
            </Show>
            <span class="ms-auto t-small text-ink-3">{t("approval.requested", { when: ago(approval().requestedAt) })}<Show when={approval().expiresAt}>{(at) => <> {t("approval.expires", { when: dateTime(at()) })}</>}</Show></span>
          </div>
        </Show>
      </Show>
      <Show when={props.diff !== "link"}>
      <Details summary={t("approval.bound")}>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 t-small text-ink-2">
          <dt>{t("approval.bound.subject")}</dt><dd class="t-code code-ltr">{shortHash(approval().subjectDigest)}</dd>
          <dt>{t("approval.bound.tool")}</dt><dd class="t-code code-ltr">{shortHash(approval().subject.toolDigest)}</dd>
          <dt>{t("approval.bound.input")}</dt><dd class="t-code code-ltr">{shortHash(approval().subject.inputDigest)}</dd>
          <dt>{t("approval.bound.workspace")}</dt><dd class="t-code code-ltr">{shortHash(approval().subject.snapshotDigest)}</dd>
          <Show when={approval().subject.patchDigest}>{(digest) => <><dt>{t("approval.bound.patch")}</dt><dd class="t-code code-ltr">{shortHash(digest())}</dd></>}</Show>
        </dl>
      </Details>
      </Show>
    </div>
  );
}
