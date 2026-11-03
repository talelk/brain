import { createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { Passkey } from "@better-auth/passkey";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { authClient } from "../../data/auth-client";
import { DateText } from "../screen-region";

export function PasskeyControls(): JSX.Element {
  const [passkeys, setPasskeys] = createSignal<Passkey[]>([]);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");

  async function load() {
    const result = await authClient.passkey.listUserPasskeys();
    if (result.error) throw new Error(result.error.message || "Could not list passkeys");
    setPasskeys(result.data ?? []);
  }

  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Passkey action failed"); }
    finally { setBusy(false); }
  }

  onMount(() => { void run(async () => undefined); });

  return <Section title="Passkeys" description="Use a device passkey or security key for phishing-resistant sign-in. Passkeys do not replace the authenticator step-up required for exact approvals." surface="card">
    <div class="flex flex-col items-start gap-3">
      <Show when={passkeys().length} fallback={<p class="text-interface text-ink-gray-7">No passkeys are registered for this account.</p>}>
        <div class="w-full divide-y divide-outline-gray-1"><For each={passkeys()}>{(passkey) => <article class="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
          <div class="min-w-0"><h3 class="break-words text-base-medium">{passkey.name || "Device passkey"}</h3><p class="break-words text-caption text-ink-gray-6">{passkey.deviceType} · registered <DateText value={passkey.createdAt?.toISOString()} /></p></div>
          <div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy()} onClick={() => { const next = window.prompt("Passkey name", passkey.name || "Device passkey"); if (next?.trim()) void run(async () => { const result = await authClient.passkey.updatePasskey({ id: passkey.id, name: next.trim() }); if (result.error) throw new Error(result.error.message || "Could not rename passkey"); setMessage("Passkey renamed."); }); }}>Rename</Button><Button size="sm" variant="outline" theme="red" disabled={busy()} onClick={() => void run(async () => { const result = await authClient.passkey.deletePasskey({ id: passkey.id }); if (result.error) throw new Error(result.error.message || "Could not delete passkey"); setMessage("Passkey deleted."); })}>Delete</Button></div>
        </article>}</For></div>
      </Show>
      <form class="grid w-full max-w-2xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = await authClient.passkey.addPasskey({ name: name().trim() || undefined }); if (result.error) throw new Error(result.error.message || "Could not register passkey"); setName(""); setMessage("Passkey registered."); }); }}>
        <TextInput label="New passkey name" description="For example Laptop or Security key" value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} disabled={busy()} />
        <Button size="md" variant="solid" theme="blue" type="submit" iconLeft="lucide-key-round" class="justify-self-start" loading={busy()} disabled={busy() || !("PublicKeyCredential" in window)}>Register a passkey</Button>
      </form>
      <Show when={message()}><p role="status" class="break-words text-interface">{message()}</p></Show>
      <Show when={error()}><Alert theme="red" variant="outline" title="Passkey action failed" description={error()} /></Show>
    </div>
  </Section>;
}
