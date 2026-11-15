import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { createPushDevice, type PushState } from "../push";
import { t } from "../../i18n";

const DISMISSED_KEY = "brain-push-offer-dismissed";
const wasDismissed = (): boolean => { try { return localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; } };

/** What this device does about notifications, in words; shared by the offer on Needs you and the control in settings. */
function statusLine(state: PushState): string {
  switch (state) {
    case "on": return t("push.status.on");
    case "off": return t("push.status.off");
    case "blocked": return t("push.status.blocked");
    case "unsupported": return t("push.status.unsupported");
    default: return t("push.status.checking");
  }
}

/**
 * The offer to turn notifications on, shown on Needs you where a person first needs it (#104). It appears only when this device could
 * receive them and has not been asked before ("Not now" is remembered on this device), and gives way to a one-line confirmation.
 */
export function PushOffer(): JSX.Element {
  const device = createPushDevice();
  const [dismissed, setDismissed] = createSignal(wasDismissed());
  const [enabledHere, setEnabledHere] = createSignal(false);
  const later = () => { setDismissed(true); try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* per-viewer convenience only */ } };
  const turnOn = async () => { await device.enable(); if (device.state() === "on") setEnabledHere(true); };
  return <>
    <Show when={device.state() === "off" && !dismissed() && !enabledHere()}>
      <section class="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-outline-gray-2 bg-surface-gray-1 px-3 py-3" aria-label={t("push.offer.label")} data-testid="push-offer">
        <span class="lucide-bell size-5 shrink-0 text-ink-gray-7" aria-hidden="true" />
        <p class="m-0 min-w-0 flex-1 basis-56 text-interface text-ink-gray-8">{t("push.offer.text")}</p>
        <div class="flex shrink-0 items-center gap-2">
          <Button variant="solid" theme="blue" size="sm" loading={device.busy()} onClick={() => void turnOn()}>{t("push.offer.enable")}</Button>
          <Button variant="ghost" size="sm" onClick={later}>{t("push.offer.later")}</Button>
        </div>
        <Show when={device.error()}><p role="alert" class="m-0 basis-full text-caption text-ink-red-7">{device.error()}</p></Show>
      </section>
    </Show>
    <Show when={enabledHere() && device.state() === "on"}>
      <p role="status" class="m-0 mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-8" data-testid="push-offer-done">
        <span class="lucide-bell-ring size-4 shrink-0 text-ink-green-8" aria-hidden="true" />{t("push.status.on")}
        <Button variant="ghost" size="sm" onClick={() => { setEnabledHere(false); void device.disable(); }}>{t("push.disable")}</Button>
      </p>
    </Show>
  </>;
}

/** Settings: this device's notification state and the one control that changes it, either way. */
export function PushDeviceControl(): JSX.Element {
  const device = createPushDevice();
  return <div class="flex flex-col items-start gap-3" data-testid="push-device">
    <p class="brain-readable text-interface text-ink-gray-7">{t("push.description")}</p>
    <p role="status" class="brain-readable m-0 text-interface text-ink-gray-9" data-state={device.state()}>{statusLine(device.state())}</p>
    <Show when={device.state() === "off"}>
      <Button variant="outline" theme="blue" iconLeft="lucide-bell" loading={device.busy()} onClick={() => void device.enable()}>{t("push.enable")}</Button>
    </Show>
    <Show when={device.state() === "on"}>
      <Button variant="outline" theme="red" iconLeft="lucide-bell-off" loading={device.busy()} onClick={() => void device.disable()}>{t("push.disable")}</Button>
    </Show>
    <Show when={device.error()}><p role="alert" class="brain-readable text-interface text-ink-red-7">{device.error()}</p></Show>
  </div>;
}
