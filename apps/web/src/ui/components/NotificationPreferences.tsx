import { For, Show, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Checkbox } from "@talelk/newui-atoms";
import { governor } from "../../data/client";

interface Preferences { push: boolean; webhook: boolean; digest: boolean; email: boolean }
interface Delivery { kind: string; status: "sent" | "failed"; reason: string; at: string }
interface View { preferences: Preferences; available: { inApp: true; push: true; webhook: boolean; email: boolean }; emailDeliveries: Delivery[] }
const kindLabel = (kind: string): string => (kind === "digest" ? "Daily summary" : kind === "result-ready" ? "Result ready" : kind === "approval" ? "Approval" : "Needs you");

/**
 * Where Brain may reach you (issue #53, ADR 0011): the in-app inbox is always on; web push, a server-configured webhook and a daily
 * digest are yours to switch. Messages carry a link, never content, and a decision still needs sign-in and step-up after the link.
 */
export function NotificationPreferences(): JSX.Element {
  const [view, { mutate }] = createResource(() => governor<View>("/v1/notification-preferences"));
  const [message, setMessage] = createSignal("");
  async function set(change: Partial<Preferences>): Promise<void> {
    setMessage("");
    try { mutate(await governor<View>("/v1/notification-preferences", change)); setMessage("Saved."); }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : "Your choice was not saved."); }
  }
  return <div class="flex min-w-0 flex-col gap-3" data-testid="notification-preferences">
    <h3 class="text-base-medium text-ink-gray-9">Where Brain reaches you</h3>
    <Show when={view()} fallback={<p class="text-interface text-ink-gray-7" role="status">{view.error ? "Your notification choices could not be read." : "Loading your choices…"}</p>}>{(loaded) => <fieldset class="flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend class="sr-only">Notification channels</legend>
      <Checkbox checked disabled label="In Brain (always on): the bell and the Needs you queue are the record." />
      <Checkbox checked={loaded().preferences.push} onCheckedChange={(checked) => void set({ push: checked === true })} label="Browser notifications for what needs you or is ready (after you enable them above)." />
      <Checkbox checked={loaded().preferences.webhook} disabled={!loaded().available.webhook} onCheckedChange={(checked) => void set({ webhook: checked === true })}
        label={loaded().available.webhook ? "Also send a link to the team webhook (for chat or a mail relay)." : "Webhook: not set up on this server. An administrator turns it on in the server settings."} />
      <Checkbox checked={loaded().preferences.email} disabled={!loaded().available.email} onCheckedChange={(checked) => void set({ email: checked === true })}
        label={loaded().available.email ? "Also email me a link when something needs a decision, and a daily summary of finished results." : "Email is not configured on this server. An administrator turns it on in the server settings."} />
      <Checkbox checked={loaded().preferences.digest} onCheckedChange={(checked) => void set({ digest: checked === true })} label="Batch finished results into one message a day. Things that need a decision are never batched." />
      <p class="text-caption text-ink-gray-6">Every message is a link. Opening it takes you to Brain, where you sign in and, for an approval, confirm again.</p>
      <Show when={loaded().available.email && loaded().emailDeliveries.length > 0}>
        <div class="flex flex-col gap-1" data-testid="email-deliveries">
          <h4 class="text-interface-medium text-ink-gray-8">Recent emails</h4>
          <ul class="m-0 flex list-none flex-col gap-1 p-0 text-caption text-ink-gray-7">
            <For each={loaded().emailDeliveries}>{(delivery) => <li>{kindLabel(delivery.kind)}, {new Date(delivery.at).toLocaleString()}: {delivery.status === "sent" ? "sent" : `failed (${delivery.reason})`}</li>}</For>
          </ul>
        </div>
      </Show>
    </fieldset>}</Show>
    <Show when={message()}><p role="status" class="text-interface text-ink-gray-8">{message()}</p></Show>
  </div>;
}
