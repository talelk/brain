import { createSignal, onMount } from "solid-js";
import { governor } from "../data/client";
import { t } from "../i18n";

/**
 * Push on this device (#104). The device is the browser: its own permission and its own push subscription decide the state, so a
 * person turns push on or off per device, and turning it off removes the subscription at both ends.
 * - `unsupported`: no service worker, push or notifications here (some phones' in-app browsers).
 * - `blocked`: the person denied notifications in the browser; only the browser's site settings can undo that.
 * - `off` / `on`: this device has no / has a subscription Brain sends to.
 */
export type PushState = "checking" | "unsupported" | "blocked" | "off" | "on";

const supported = (): boolean => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The service worker's registration; one that never becomes ready (no worker on this origin) reads as unsupported rather than hanging. */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return await Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000))]);
}

const keyBytes = (publicKey: string): Uint8Array => Uint8Array.from(atob(publicKey.replace(/-/gu, "+").replace(/_/gu, "/")), (character) => character.charCodeAt(0));

export function createPushDevice() {
  const [state, setState] = createSignal<PushState>("checking");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function refresh(): Promise<void> {
    if (!supported()) { setState("unsupported"); return; }
    if (Notification.permission === "denied") { setState("blocked"); return; }
    const ready = await registration();
    if (!ready) { setState("unsupported"); return; }
    setState((await ready.pushManager.getSubscription()) ? "on" : "off");
  }

  /** Asks the browser's permission, subscribes this device and tells Brain; a refusal at any step leaves this device off. */
  async function enable(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    let subscribed: PushSubscription | undefined;
    try {
      if (await Notification.requestPermission() !== "granted") { setState(Notification.permission === "denied" ? "blocked" : "off"); return; }
      const ready = await registration();
      if (!ready) { setState("unsupported"); return; }
      const { publicKey } = await governor<{ publicKey: string }>("/v1/push/vapid-public-key");
      subscribed = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
      await governor("/v1/push/subscriptions", subscribed.toJSON());
      // Choosing push on a device is choosing push: the person-wide switch must not silently veto it.
      await governor("/v1/notification-preferences", { push: true });
      setState("on");
    } catch (failure) {
      await subscribed?.unsubscribe().catch(() => false);
      setError(failure instanceof Error && failure.message ? failure.message : t("push.error.enable"));
      await refresh();
    } finally { setBusy(false); }
  }

  /** Removes this device from Brain first (so nothing is sent to it again), then from the browser. */
  async function disable(): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const ready = await registration();
      const current = await ready?.pushManager.getSubscription();
      if (current) {
        await governor("/v1/push/subscriptions/delete", { endpoint: current.endpoint });
        await current.unsubscribe();
      }
      setState("off");
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t("push.error.disable"));
      await refresh();
    } finally { setBusy(false); }
  }

  onMount(() => void refresh());
  return { state, busy, error, enable, disable };
}
