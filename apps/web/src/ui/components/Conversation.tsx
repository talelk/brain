import { Index, Show, createSignal } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { ConversationView, ConversationSummary } from "@brain/contracts";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { ScreenRegion } from "../screen-region";
import { ActionFeedback } from "./ActionFeedback";
import { DetailAside, WorkspaceSection } from "./Domain";

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
  return <form onSubmit={send} class="flex flex-col gap-3"><Textarea label="Your request" description="Describe the outcome, constraints and useful context. Brain proposes a published recipe; starting it requires your review." value={text()} maxlength={4000} required disabled={busy() || props.disabled} placeholder="Describe the work you need — Brain will propose a recipe for your review." onInput={(e) => { setText(e.currentTarget.value); setId(crypto.randomUUID()); }} /><ActionFeedback tone="error" message={error()} /><Button type="submit" loading={busy()} disabled={busy() || props.disabled || !text().trim()} iconLeft="lucide-send" class="self-start">Send request</Button></form>;
}
function Thread(props: { id: string; onDraft: (id: string) => void }) {
  const app = useApp();
  const read = createScopedRead<ConversationView>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<ConversationView>(`/v1/conversations/${encodeURIComponent(props.id)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }), refreshMs: 2000 });
  const pending = () => read.state().data?.messages.some((message) => message.state === "pending");
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Start a conversation" emptyDescription="Describe the outcome you want.">
    <section class="mb-4 flex flex-col gap-2" aria-label="Conversation history"><Index each={read.state().data?.messages}>{(message) => <article class={`max-w-3xl rounded-card p-3 ${message().role === "user" ? "ms-auto bg-surface-blue-1" : "me-auto border border-outline-gray-1 bg-surface-elevation-1"}`}><strong class="text-caption text-ink-gray-6">{message().role === "user" ? "You" : "Brain · proposal only"}</strong><p class="brain-prose mt-2 whitespace-pre-wrap break-words text-interface">{message().text}</p><Show when={message().state === "pending"}><p role="status" class="mt-2 text-caption text-ink-gray-6">Waiting for a verified proposal. If a model or runner is unavailable, you can choose a task directly.</p></Show><Show when={message().draftId}><Button class="mt-3" onClick={() => props.onDraft(message().draftId!)}>Review proposed task</Button></Show></article>}</Index></section>
    <Composer disabled={!app.canDispatch() || pending() || !read.state().canMutate} onSend={async (text, id) => { await governor(`/v1/conversations/${encodeURIComponent(props.id)}/messages`, { workspaceId: app.workspaceId(), id, text }); await read.refresh(); }} />
  </ScreenRegion>;
}
export function Conversation(props: { onDraft: (id: string) => void }) {
  const app = useApp(); const [params, setParams] = useSearchParams(); const thread = () => typeof params.conversation === "string" ? params.conversation : "";
  const [proposedId, setProposedId] = createSignal(crypto.randomUUID());
  const history = createScopedRead<ConversationSummary[]>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<ConversationSummary[]>(`/v1/conversations?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  return <div class="brain-run-layout"><WorkspaceSection title="Describe the work" description="Turn a goal into a reviewable task proposal through a scoped conversation; the proposal pins a published recipe from the active release." actions={<Show when={thread()}><Button variant="outline" onClick={() => { setProposedId(crypto.randomUUID()); setParams({ conversation: undefined }); }}>New conversation</Button></Show>}>
    <Alert theme="blue" variant="outline" title="Proposal, not execution" description="Messages cannot approve effects or start a run. You will review the exact task, inputs and readiness before any launch." />
    <Show when={thread()} keyed fallback={<Composer disabled={!app.canDispatch()} onSend={async (text, id) => {
      await governor("/v1/conversations", { workspaceId: app.workspaceId(), id: proposedId() });
      await governor(`/v1/conversations/${proposedId()}/messages`, { workspaceId: app.workspaceId(), id, text });
      setParams({ conversation: proposedId() }); await history.refresh();
    }} />}>{(id) => <Thread id={id} onDraft={props.onDraft} />}</Show>
    <Show when={history.state().data?.length}><details><summary class="cursor-pointer text-interface font-medium">Recent conversations</summary><Index each={history.state().data}>{(entry) => <div class="mt-1 max-w-full"><Button variant="ghost" class="h-auto max-w-full whitespace-normal break-words text-start" onClick={() => setParams({ conversation: entry().id })}>Resume: {entry().preview}</Button></div>}</Index></details></Show>
  </WorkspaceSection><DetailAside title="Conversation scope" description="What this mode can and cannot do.">
    <dl class="grid gap-3 border-y border-outline-gray-1 py-4"><div><dt class="text-caption text-ink-gray-6">Workspace</dt><dd class="mt-1 text-base-medium">{app.workspaceOptions().find((item) => item.value === app.workspaceId())?.label ?? app.workspaceId()}</dd></div><div><dt class="text-caption text-ink-gray-6">Output</dt><dd class="mt-1 text-base-medium">A task proposal for human review</dd></div><div><dt class="text-caption text-ink-gray-6">Authority</dt><dd class="mt-1 text-base-medium">No execution or external effect</dd></div></dl>
    <p class="text-interface text-ink-gray-6">Only the active workspace and current authorized release are used. Starting the proposed task is always a separate action.</p>
  </DetailAside></div>;
}
