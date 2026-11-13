import { createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { Passkey } from "@better-auth/passkey";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { authClient } from "../../data/auth-client";
import { DateText } from "../screen-region";
import { FormSheet } from "./BrainForm";
import { t } from "../../i18n";

export function PasskeyControls(): JSX.Element {
  const [passkeys, setPasskeys] = createSignal<Passkey[]>([]);
  const [name, setName] = createSignal("");
  // null: closed; "" : adding; otherwise the id of the passkey being renamed.
  const [sheet, setSheet] = createSignal<string | null>(null);
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

  return <Section title={t("adm.passkeys.caab")} description={t("adm.use-a-device-passkey-or-security.604f")} surface="card">
    <div class="flex flex-col items-start gap-3">
      <Show when={passkeys().length} fallback={<p class="text-interface text-ink-gray-7">{t("adm.no-passkeys-are-registered-for-t.df1a")}</p>}>
        <div class="w-full divide-y divide-outline-gray-1"><For each={passkeys()}>{(passkey) => <article class="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
          <div class="min-w-0"><h3 class="break-words text-base-medium">{passkey.name || "Device passkey"}</h3><p class="break-words text-caption text-ink-gray-6">{passkey.deviceType} · registered <DateText value={passkey.createdAt?.toISOString()} /></p></div>
          <div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy()} onClick={() => { setName(passkey.name || "Device passkey"); setSheet(passkey.id); }}>{t("adm.rename.d3f4")}</Button><Button size="sm" variant="outline" theme="red" disabled={busy()} onClick={() => void run(async () => { const result = await authClient.passkey.deletePasskey({ id: passkey.id }); if (result.error) throw new Error(result.error.message || "Could not delete passkey"); setMessage("Passkey deleted."); })}>{t("adm.delete.f6fd")}</Button></div>
        </article>}</For></div>
      </Show>
      <Button variant="solid" theme="blue" iconLeft="lucide-key-round" disabled={busy() || !("PublicKeyCredential" in window)} onClick={() => { setName(""); setSheet(""); }}>{t("adm.register-a-passkey.092e")}</Button>
      <FormSheet centered={!sheet()} open={sheet() !== null} onClose={() => setSheet(null)} title={sheet() ? t("adm.rename-passkey.cb92") : t("adm.register-a-passkey.092e")} description={sheet() ? t("adm.the-name-only-helps-you-recognis.62ab") : t("adm.your-browser-will-ask-you-to-con.7d0c")}
        submit={sheet() ? t("adm.save-name.8ce6") : t("adm.register-a-passkey.092e")} icon="lucide-key-round" busy={busy()} error={error()} errorTitle={t("adm.passkey-action-failed.fc30")}
        onSubmit={() => run(async () => {
          const id = sheet();
          if (id) { const result = await authClient.passkey.updatePasskey({ id, name: name().trim() || "Device passkey" }); if (result.error) throw new Error(result.error.message || "Could not rename passkey"); setMessage("Passkey renamed."); }
          else { const result = await authClient.passkey.addPasskey({ name: name().trim() || undefined }); if (result.error) throw new Error(result.error.message || "Could not register passkey"); setMessage("Passkey registered."); }
          setName(""); setSheet(null);
        })}>
        <TextInput label={t("adm.passkey-name.b429")} description={t("adm.for-example-laptop-or-security-k.2c7c")} value={name()} onInput={(event) => setName(event.currentTarget.value)} maxlength={100} disabled={busy()} />
      </FormSheet>
      <Show when={message()}><p role="status" class="break-words text-interface">{message()}</p></Show>
      <Show when={error() && sheet() === null}><Alert theme="red" variant="outline" title={t("adm.passkey-action-failed.fc30")} description={error()} /></Show>
    </div>
  </Section>;
}
