import { Index, Show, createSignal } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Button, Textarea } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { ConversationView, ConversationSummary } from "@brain/contracts";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { ScreenRegion } from "../screen-region";
import { ActionFeedback } from "./ActionFeedback";

function Composer(props: { disabled?: boolean; onSend: (text: string, id: string) => Promise<void> }) {
  const [text, setText] = createSignal(""); const [id, setId] = createSignal(crypto.randomUUID());
  const [busy, setBusy] = createSignal(false); const [error, setError] = createSignal("");
  async function send(event: SubmitEvent) {
    event.preventDefault(); if (!text().trim() || busy()) return;
    setBusy(true); setError("");
    try { await props.onSend(text().trim(), id()); setText(""); setId(crypto.randomUUID()); }
    catch (e) { setError(e instanceof Error ? e.message : "Message could not be confirmed. Retry this same message to recover it."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={send} class="flex flex-col gap-3"><Textarea label="Your request" description="Describe your goal. Brain can prepare an existing task; starting it requires your confirmation." value={text()} maxlength={4000} required disabled={busy() || props.disabled} onInput={(e) => { setText(e.currentTarget.value); setId(crypto.randomUUID()); }} /><ActionFeedback tone="error" message={error()} /><Button size="lg" type="submit" loading={busy()} disabled={busy() || props.disabled || !text().trim()}>Send request</Button></form>;
}
function Thread(props: { id: string; onDraft: (id: string) => void }) {
  const app = useApp();
  const read = createScopedRead<ConversationView>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<ConversationView>(`/v1/conversations/${encodeURIComponent(props.id)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }), refreshMs: 2000 });
  const pending = () => read.state().data?.messages.some((message) => message.state === "pending");
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Start a conversation" emptyDescription="Describe the outcome you want.">
    <section class="mb-4 flex flex-col gap-3" aria-label="Conversation history"><Index each={read.state().data?.messages}>{(message) => <article class="rounded-card border border-outline-gray-2 p-3"><strong>{message().role === "user" ? "You" : "Brain"}</strong><p class="whitespace-pre-wrap break-words">{message().text}</p><Show when={message().state === "pending"}><p role="status">Waiting for a verified proposal. If a model or runner is unavailable, you can choose a task directly.</p></Show><Show when={message().draftId}><Button size="lg" class="mt-3" onClick={() => props.onDraft(message().draftId!)}>Review proposed task</Button></Show></article>}</Index></section>
    <Composer disabled={!app.canDispatch() || pending() || !read.state().canMutate} onSend={async (text, id) => { await governor(`/v1/conversations/${encodeURIComponent(props.id)}/messages`, { workspaceId: app.workspaceId(), id, text }); await read.refresh(); }} />
  </ScreenRegion>;
}
export function Conversation(props: { onDraft: (id: string) => void }) {
  const app = useApp(); const [params, setParams] = useSearchParams(); const thread = () => typeof params.conversation === "string" ? params.conversation : "";
  const [proposedId, setProposedId] = createSignal(crypto.randomUUID());
  const history = createScopedRead<ConversationSummary[]>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<ConversationSummary[]>(`/v1/conversations?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  return <Section title="Ask Brain" description="Discuss a goal using recent messages, answer a few questions and review a task proposal. Conversation cannot approve or execute effects." surface="card" actions={<Show when={thread()}><Button size="lg" variant="outline" onClick={() => { setProposedId(crypto.randomUUID()); setParams({ conversation: undefined }); }}>New conversation</Button></Show>}>
    <Show when={thread()} keyed fallback={<Composer disabled={!app.canDispatch()} onSend={async (text, id) => {
      await governor("/v1/conversations", { workspaceId: app.workspaceId(), id: proposedId() });
      await governor(`/v1/conversations/${proposedId()}/messages`, { workspaceId: app.workspaceId(), id, text });
      setParams({ conversation: proposedId() }); await history.refresh();
    }} />}>{(id) => <Thread id={id} onDraft={props.onDraft} />}</Show>
    <Show when={history.state().data?.length}><details class="mt-4"><summary class="cursor-pointer">Recent conversations</summary><Index each={history.state().data}>{(entry) => <div class="mt-2"><Button size="lg" variant="ghost" onClick={() => setParams({ conversation: entry().id })}>Resume: {entry().preview}</Button></div>}</Index></details></Show>
  </Section>;
}
