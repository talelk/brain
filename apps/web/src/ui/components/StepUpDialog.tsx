import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog } from "@talelk/newui-molecules";
import { governor } from "../../data/client";
import { useApp } from "../app-context";
import { BrainForm } from "./BrainForm";
import { t } from "../../i18n";

/**
 * The confirmation of an administrative change that needs a fresh step-up (ADR 0047): what will happen in plain words, the person's own
 * authenticator code when two-factor is required, and one button. Confirming asks Brain for a challenge bound to this exact change, verifies
 * it, and sends the command with the evidence; nothing is changed until all three succeed, and a refusal is shown here in Brain's own words.
 */
export function StepUpDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "red" | "blue";
  /** Disables confirming until the change is complete (a reason typed, a preset chosen). */
  ready?: boolean;
  command: "workspace.autonomyCeiling.set" | "workspace.sessions.stopAll";
  /** The change itself, without the workspace and the evidence the dialog adds. */
  change: () => { preset: "supervised" | "standard" | "autonomous" } | { reason: string };
  onDone: () => void | Promise<void>;
  children?: JSX.Element;
}): JSX.Element {
  const app = useApp();
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const needsCode = () => Boolean(app.identity()?.requireTwoFactor);
  const complete = () => (props.ready ?? true) && (!needsCode() || /^\d{6}$/u.test(code()));

  const close = () => { if (busy()) return; setCode(""); setError(""); props.onClose(); };

  async function confirm(): Promise<void> {
    if (busy() || !complete()) return;
    setBusy(true); setError("");
    const entered = code();
    try {
      const workspaceId = app.workspaceId();
      const payload = { workspaceId, ...props.change() };
      const challenge = await governor<{ challengeId: string }>("/v1/step-up/commands", { commandType: props.command, workspaceId, payload });
      const evidence = await governor<{ evidenceId: string }>("/v1/step-up/commands/verify", { challengeId: challenge.challengeId, ...(entered ? { code: entered } : {}) });
      const receipt = await app.run(props.command, { ...payload, stepUpEvidenceId: evidence.evidenceId } as never);
      if (!receipt.accepted) throw new Error(receipt.detail);
      setCode("");
      await props.onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("decision.refused"));
    } finally { setBusy(false); }
  }

  return <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) close(); }}>
    <Dialog.Content size="md">
      <Dialog.Header class="min-w-0"><Dialog.Title>{props.title}</Dialog.Title><Dialog.Description class="break-words [overflow-wrap:anywhere]">{props.description}</Dialog.Description></Dialog.Header>
      <BrainForm bare label={props.title} onSubmit={confirm}>
        <div class="my-3 flex min-w-0 flex-col gap-3" data-step-up-dialog={props.command}>
          {props.children}
          <div class="rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3">
            <p class="m-0 mb-2 text-caption font-medium text-ink-gray-7">{t("work.stepup.title")}</p>
            <Show when={needsCode()} fallback={<p class="m-0 text-interface text-ink-gray-8" data-step-up-session>{t("work.stepup.session")}</p>}>
              <TextInput label={t("work.stepup.code")} description={t("work.stepup.codeHint")} autocomplete="one-time-code" inputmode="numeric" maxlength={6} pattern="[0-9]{6}" value={code()}
                disabled={busy()} onInput={(event) => setCode(event.currentTarget.value)} />
            </Show>
          </div>
          <Show when={error()}><Alert theme="red" variant="outline" title={t("work.stepup.failed")} description={error()} /></Show>
        </div>
        <Dialog.Footer class="flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy()} onClick={close}>{t("decision.cancel")}</Button>
          <Button type="submit" size="sm" variant="solid" theme={props.tone ?? "blue"} loading={busy()} disabled={!complete() || busy()}>{props.confirmLabel}</Button>
        </Dialog.Footer>
      </BrainForm>
    </Dialog.Content>
  </Dialog.Root>;
}
