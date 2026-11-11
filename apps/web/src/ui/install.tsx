import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";

/** Chromium's install event: not in lib.dom, and absent elsewhere (Safari, Firefox), where the prompt simply never shows. */
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

const DISMISSED_KEY = "brain-install-dismissed";
const readDismissed = (): boolean => { try { return localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; } };
const [deferred, setDeferred] = createSignal<InstallEvent>();
const [dismissed, setDismissed] = createSignal(readDismissed());

/** Called once at start-up: the browser fires `beforeinstallprompt` early, before Today exists, so it is kept until Today asks. */
export function listenForInstall(): void {
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); setDeferred(event as InstallEvent); });
  window.addEventListener("appinstalled", () => setDeferred(undefined));
}

/** The home-screen badge shows the Needs-you count and clears at zero; where the Badging API is missing nothing happens. */
export function createAppBadge(count: () => number): void {
  const nav = navigator as BadgeNavigator;
  createEffect(() => {
    const n = count();
    try {
      if (n > 0) void nav.setAppBadge?.(n).catch(() => undefined);
      else void nav.clearAppBadge?.().catch(() => undefined);
    } catch { /* unsupported: the in-app bell still shows the count */ }
  });
  onCleanup(() => { try { void nav.clearAppBadge?.().catch(() => undefined); } catch { /* ignore */ } });
}

/** A quiet, dismissible offer to put Brain on the phone's home screen; remembered once dismissed or installed. */
export function InstallPrompt(): JSX.Element {
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* per-viewer convenience only */ } };
  const install = async () => {
    const event = deferred();
    if (!event) return;
    setDeferred(undefined);
    try { await event.prompt(); await event.userChoice; } catch { /* the browser declined: nothing to do */ }
    dismiss();
  };
  return <Show when={deferred() && !dismissed()}>
    <section class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-outline-gray-2 bg-surface-gray-1 px-3 py-3" aria-label="Install Brain" data-testid="install-prompt">
      <span class="lucide-smartphone size-5 shrink-0 text-ink-gray-7" aria-hidden="true" />
      <p class="m-0 min-w-0 flex-1 basis-56 text-interface text-ink-gray-8">Install Brain on your phone. It opens like an app and shows how many things need you.</p>
      <div class="flex shrink-0 items-center gap-2">
        <Button variant="solid" theme="blue" size="sm" onClick={() => void install()}>Install</Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>Not now</Button>
      </div>
    </section>
  </Show>;
}
