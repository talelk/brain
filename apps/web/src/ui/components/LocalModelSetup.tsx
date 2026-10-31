import { useNavigate } from "@solidjs/router";
import { useApp } from "../app-context";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { LocalRuntimeStatus } from "@brain/contracts";
import { governor } from "../../data/client";
import { OperationalChecklist } from "./OperationalChecklist";

export function LocalModelSetup() {
  const app = useApp(); const navigate = useNavigate();
  const [status, setStatus] = createSignal<LocalRuntimeStatus>();
  const [url, setUrl] = createSignal("");
  const [model, setModel] = createSignal("");
  const [key, setKey] = createSignal("");
  const [removeKey, setRemoveKey] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  let disposed = false;
  async function load(initial = false) {
    try {
      const next = await governor<LocalRuntimeStatus>("/v1/local-runtime");
      if (disposed) return;
      setStatus(next);
      if (initial) { setUrl(next.modelUrl ?? ""); setModel(next.modelId ?? ""); }
    } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Model setup is unavailable."); }
  }
  onMount(() => { void load(true); const timer = setInterval(() => void load(), 3000); onCleanup(() => { disposed = true; clearInterval(timer); }); });
  async function connect(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await governor<LocalRuntimeStatus>("/v1/local-runtime/connect", { modelUrl: url().trim(), modelId: model().trim(), ...(key() ? { apiKey: key() } : removeKey() ? { apiKey: "" } : {}) });
      if (disposed) return;
      setStatus(next); setKey(""); setRemoveKey(false);
      setMessage("Model found. Local runners are applying the connection; active attempts finish with their existing settings. Run the installation test below when runners are ready.");
    } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Could not connect to the model."); }
    finally { if (!disposed) setBusy(false); }
  }
  return <div class="flex flex-col gap-field-gap">
    <Section actions={<Button size="lg" variant="outline" onClick={() => void navigate(`/w/${app.workspaceId()}/workflows?mode=catalog`)}>Explore starter tasks</Button>} title="Connect your local model" description="Use your self-hosted OpenAI-compatible model API with Pi. The starter release assumes no model usage charges. Paid providers require explicit budgets in your authored release." surface="card">
      <Show when={status()?.enabled} fallback={<p>Guided local setup is available when this installation starts with <code>pnpm brain start</code>. Other deployments use their configured runner connections.</p>}>
        <form onSubmit={connect} class="flex max-w-2xl flex-col gap-4">
          <TextInput label="Model API URL" placeholder="http://localhost:8000/v1" description="Use the address reachable from this host, including /v1 when required." value={url()} onInput={(e) => setUrl(e.currentTarget.value)} required disabled={busy()} />
          <TextInput label="Model ID" description="Enter the exact ID advertised by your model server." value={model()} onInput={(e) => setModel(e.currentTarget.value)} required disabled={busy()} />
          <TextInput label="Model API key" type="password" autocomplete="off" description={status()?.hasApiKey ? "A key is saved. Leave blank to retain it for the same endpoint." : "Optional for a local endpoint without authentication."} value={key()} onInput={(e) => { setKey(e.currentTarget.value); setRemoveKey(false); }} disabled={busy()} />
          <Show when={status()?.hasApiKey}><Button size="lg" type="button" variant="ghost" onClick={() => { setKey(""); setRemoveKey(!removeKey()); }}>{removeKey() ? "Keep saved key" : "Remove saved key on connect"}</Button></Show>
          <Button size="lg" type="submit" loading={busy()} disabled={busy() || !url().trim() || !model().trim()}>Test connection and start runners</Button>
        </form>
        <Show when={status()?.configured}><div class="mt-4"><h3 class="text-base-medium">Local execution</h3><For each={status()?.runners}>{(runner) => <p>{runner.id.includes("evaluators") ? "Independent validator" : "Task runner"}: {runner.applied ? "Ready" : runner.connected ? "Applying model settings after the current attempt" : "Waiting for connection"}</p>}</For></div></Show>
      </Show>
      <Show when={message()}><p role="status" class="mt-4">{message()}</p></Show>
      <Show when={error()}><p role="alert" class="mt-4">{error()}</p></Show>
    </Section>
    <OperationalChecklist />
  </div>;
}
