import { createSignal, Show } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog } from "@talelk/newui-molecules";
import { governor } from "../../data/client";
import { DateText } from "../screen-region";
import { BrainForm } from "./BrainForm";

export function RunnerEnrollmentDialog(props: {
  open: boolean;
  onClose: () => void;
  defaultGroup?: string;
  runnerId?: string;
}) {
  const [groupId, setGroupId] = createSignal("");
  const [token, setToken] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const group = () => groupId().trim() || props.defaultGroup || "agents";

  async function issue() {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const result = await governor<{ token: string; expiresAt: string }>("/v1/runner-tokens", { groupId: group() });
      setToken(result.token); setExpiresAt(result.expiresAt);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not issue the enrollment credential"); }
    finally { setBusy(false); }
  }

  function close() {
    setToken(""); setExpiresAt(""); setError(""); setGroupId("");
    props.onClose();
  }

  return <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) close(); }}><Dialog.Content size="md">
    <Dialog.Header><Dialog.Title>{props.runnerId ? "Rotate runner enrollment" : "Enroll a runner"}</Dialog.Title><Dialog.Description>Issue a one-use, ten-minute credential. Brain records the verified identity only after the outbound runner completes enrollment and signed hello.</Dialog.Description></Dialog.Header>
    <BrainForm bare label="Runner enrollment" onSubmit={() => (token() ? undefined : issue())}>
    <div class="my-3 flex max-h-[60dvh] flex-col gap-3 overflow-y-auto pe-1">
      <TextInput label="Runner group" value={group()} onInput={(event) => { setGroupId(event.currentTarget.value); setToken(""); }} description="The group must exist in reviewed configuration. Runner hello cannot elevate this assignment." disabled={busy() || Boolean(token())} />
      <Show when={!token()}><Alert theme="blue" variant="outline" title="Enrollment stays on the runner" description="The token is shown once. It does not mark a runner online, healthy or capability-verified by itself." /></Show>
      <Show when={token()}><div class="flex min-w-0 flex-col gap-3"><Alert theme="amber" variant="outline" title="Copy this credential now" description={<>One use only · expires <DateText value={expiresAt()} /></>} /><TextInput label="One-use enrollment token" value={token()} readonly /><div class="min-w-0"><h3 class="text-base-medium">Start or restart the outbound supervisor</h3><p class="mt-1 break-words text-interface text-ink-gray-7">Set the token and runner identity in its private environment. Do not place the token in source control or a shared log.</p><pre class="mt-3 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-gray-1 p-3 text-caption">BRAIN_GOVERNOR_URL={location.origin}{"\n"}BRAIN_RUNNER_ENROLL_TOKEN={token()}{"\n"}BRAIN_RUNNER_ID={props.runnerId ?? "runner-replace-me"}{"\n"}pnpm exec tsx apps/runner/src/main.ts</pre></div><p class="break-words text-caption text-ink-gray-6">After re-enrollment, review the fresh heartbeat and verified capabilities before enabling the runner.</p></div></Show>
      <Show when={error()}><Alert theme="red" variant="outline" title="Enrollment credential was not issued" description={error()} /></Show>
    </div>
    <Dialog.Footer class="flex-wrap justify-end gap-2"><Button variant="outline" onClick={close}>Close</Button><Show when={!token()}><Button type="submit" variant="solid" theme="blue" loading={busy()} disabled={busy() || !group()}>Issue one-use token</Button></Show></Dialog.Footer>
    </BrainForm>
  </Dialog.Content></Dialog.Root>;
}
