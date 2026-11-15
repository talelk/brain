import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { chatIdentitiesRead, type ChatIdentity, type ChatProvider } from "../../data/engine";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "./Domain";
import { OrganizationMemberSelect } from "./OrganizationAdmin";
import { t } from "../../i18n";

const PROVIDERS: readonly ChatProvider[] = ["slack", "teams", "brain"];
const providerLabel = (provider: ChatProvider): string => t(`chat.provider.${provider}`);

/**
 * Chat identities (ADR 0011 amendment): which member a signed chat message is from. An administrator links a Slack or Teams user (or a
 * sender of the signed hook) to one member; that person may then start a mission from a Play in chat with their own access. Nothing is
 * linked by default, and chat can never approve or confirm anything.
 */
export function ChatIdentities(): JSX.Element {
  const app = useApp();
  const mayEdit = () => Boolean(app.identity()?.actor.scopes.includes("identity:security"));
  const read = createScopedRead<{ identities: ChatIdentity[] }>({ scope: app.scope, live: true, load: (_scope, signal) => chatIdentitiesRead(signal) });
  const [provider, setProvider] = createSignal<ChatProvider>("slack");
  const [chatUserId, setChatUserId] = createSignal("");
  const [principalId, setPrincipalId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | undefined>();
  const identities = () => read.state().data?.identities ?? [];

  async function act(work: () => Promise<{ accepted: boolean; detail: string }>, done: string): Promise<void> {
    if (busy()) return;
    setBusy(true); setResult(undefined);
    try {
      const receipt = await work();
      if (!receipt.accepted) throw new Error(receipt.detail);
      setResult({ ok: true, text: done });
      await read.refresh({ force: true });
    } catch (cause) { setResult({ ok: false, text: cause instanceof Error ? cause.message : t("decision.refused") }); } finally { setBusy(false); }
  }
  const link = () => act(async () => {
    const receipt = await app.run("chatIdentity.set", { provider: provider(), chatUserId: chatUserId().trim(), principalId: principalId() });
    if (receipt.accepted) { setChatUserId(""); setPrincipalId(""); }
    return receipt;
  }, t("chat.linked"));
  const unlink = (identity: ChatIdentity) => act(() => app.run("chatIdentity.remove", { provider: identity.provider, chatUserId: identity.chatUserId }), t("chat.unlinked"));

  return <WorkspaceSection title={t("chat.title")} description={t("chat.description")}>
    <ScreenRegion state={read.state()} skeleton="rows" emptyTitle={t("chat.empty.title")} emptyDescription={t("chat.empty.description")} onRetry={() => void read.refresh({ force: true })}>
      <div class="flex min-w-0 flex-col gap-3" data-chat-identities>
        <Show when={identities().length === 0}><p class="m-0 text-interface text-ink-gray-7" data-chat-empty>{t("chat.empty.description")}</p></Show>
        <ul class="m-0 flex list-none flex-col p-0">
          <For each={identities()}>{(identity) => <li class="flex min-w-0 flex-wrap items-center justify-between gap-2 border-y border-outline-gray-1 py-2" data-chat-identity={`${identity.provider}:${identity.chatUserId}`}>
            <div class="min-w-0">
              <p class="m-0 flex min-w-0 flex-wrap items-center gap-2 text-interface text-ink-gray-9"><Badge variant="outline" theme="gray" label={providerLabel(identity.provider)} /><code class="break-all">{identity.chatUserId}</code></p>
              <p class="m-0 mt-0.5 break-words text-caption text-ink-gray-6">{t("chat.linkedTo", { name: identity.name || identity.email || identity.principalId })}<Show when={!identity.active}> <Badge variant="outline" theme="amber" label={t("chat.suspended")} /></Show></p>
            </div>
            <Show when={mayEdit()}><Button variant="outline" size="sm" disabled={busy()} aria-label={t("chat.unlinkAria", { who: identity.chatUserId })} onClick={() => void unlink(identity)}>{t("chat.unlink")}</Button></Show>
          </li>}</For>
        </ul>
        <Show when={!mayEdit()}><p class="m-0 text-interface text-ink-gray-7">{t("chat.readOnly")}</p></Show>
        <Show when={mayEdit()}>
          <form class="flex min-w-0 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void link(); }}>
            <Select label={t("chat.provider")} value={provider()} onValueChange={(next) => setProvider((next as ChatProvider | null) ?? "slack")} options={PROVIDERS.map((value) => ({ value, label: providerLabel(value) }))} />
            <TextInput label={t("chat.userId")} description={t("chat.userIdHint")} autocomplete="off" spellcheck={false} value={chatUserId()} onInput={(event) => setChatUserId(event.currentTarget.value)} />
            <OrganizationMemberSelect value={principalId()} onChange={setPrincipalId} />
            <div><Button type="submit" variant="solid" theme="blue" size="sm" loading={busy()} disabled={busy() || !chatUserId().trim() || !principalId()}>{t("chat.link")}</Button></div>
          </form>
        </Show>
        <Show when={result()}>{(outcome) => <p role={outcome().ok ? "status" : "alert"} class={`m-0 text-interface ${outcome().ok ? "text-ink-green-8" : "text-ink-red-8"}`}>{outcome().text}</p>}</Show>
      </div>
    </ScreenRegion>
  </WorkspaceSection>;
}
