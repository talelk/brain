import { useNavigate } from "@solidjs/router";
import { useApp } from "../app-context";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { LocalRuntimeStatus } from "@brain/contracts";
import { governor } from "../../data/client";
import { OperationalChecklist } from "./OperationalChecklist";
import { FactStrip } from "./Domain";
import { FormSheet } from "./BrainForm";

export function LocalModelSetup() {
  const app = useApp(); const navigate = useNavigate();
  const [status, setStatus] = createSignal<LocalRuntimeStatus>();
  const [url, setUrl] = createSignal("");
  const [model, setModel] = createSignal("");
  const [key, setKey] = createSignal("");
  const [removeKey, setRemoveKey] = createSignal(false);
  const [open, setOpen] = createSignal(false);
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
  async function connect() {
    if (busy() || !url().trim() || !model().trim()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await governor<LocalRuntimeStatus>("/v1/local-runtime/connect", { modelUrl: url().trim(), modelId: model().trim(), ...(key() ? { apiKey: key() } : removeKey() ? { apiKey: "" } : {}) });
      if (disposed) return;
      setStatus(next); setKey(""); setRemoveKey(false); setOpen(false);
      setMessage("Model found. Local runners are applying the connection; active attempts finish with their existing settings. Run the installation test below when runners are ready.");
    } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Could not connect to the model."); }
    finally { if (!disposed) setBusy(false); }
  }
  const taskRunnerReady = () => Boolean(status()?.runners.some((runner) => !runner.id.includes("evaluators") && runner.applied));
  return <div class="flex flex-col gap-4">
    <Section actions={<div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap"><Button variant="outline" class="w-full sm:w-auto" onClick={() => void navigate(`/w/${app.workspaceId()}/plays?mode=catalog`)}>Explore starter tasks</Button><Button variant="solid" theme="blue" class="w-full sm:w-auto" disabled={!taskRunnerReady()} onClick={() => void navigate(`/plays/agent-smoke`)}>Run read-only smoke task</Button></div>} title="Models & Providers" description="Configure the local OpenAI-compatible connection, verify the exact model, then check engine and runner readiness separately. Saved credentials are never returned to the browser." surface="card">
      <FactStrip label="Model readiness" items={[
        { label: "Configured", value: <span class="break-all">{status()?.configured ? `Saved · ${status()?.modelId ?? "model"}` : "Not configured"}</span>, hint: "Exact provider model ID", icon: "lucide-settings-2" },
        { label: "Endpoint", value: status()?.testedAt ? "Model verified" : "Not tested", hint: status()?.testedAt ? `Verified ${new Date(status()!.testedAt!).toLocaleString()}` : "HTTP health alone is not execution proof", icon: "lucide-plug-zap" },
        { label: "Engine / runner", value: taskRunnerReady() ? "Pi ready" : "Not ready", hint: taskRunnerReady() ? "Fresh runner capability confirms the applied connection" : "Wait for signed hello and fresh runner capabilities", icon: "lucide-cpu" },
      ]} />
      <Show when={status()?.enabled} fallback={<p class="brain-readable text-interface text-ink-gray-7">Guided local setup is available when this installation starts with <code>pnpm brain start</code>. Other deployments use their configured runner connections.</p>}>
        <div><Button variant="solid" theme="blue" iconLeft="lucide-plug-zap" onClick={() => { setError(""); setOpen(true); }}>{status()?.configured ? "Change model connection" : "Configure model"}</Button></div>
        <FormSheet open={open()} onClose={() => setOpen(false)} title="Connect a local model" description="Brain tests the endpoint and model ID, then starts the local runners with the saved connection."
          submit="Test connection and start runners" icon="lucide-plug-zap" busy={busy()} disabled={!url().trim() || !model().trim()} onSubmit={connect} error={error()} errorTitle="Could not connect to the model">
          <TextInput label="Model API URL" placeholder="http://localhost:8000/v1" description="Use the address reachable from this host, including /v1 when required." value={url()} onInput={(e) => setUrl(e.currentTarget.value)} required disabled={busy()} />
          <TextInput label="Model ID" description="Enter the exact ID advertised by your model server." value={model()} onInput={(e) => setModel(e.currentTarget.value)} required disabled={busy()} />
          <div><TextInput label="Model API key" type="password" autocomplete="off" description={status()?.hasApiKey ? "A key is saved. Leave blank to retain it for the same endpoint." : "Optional for a local endpoint without authentication."} value={key()} onInput={(e) => { setKey(e.currentTarget.value); setRemoveKey(false); }} disabled={busy()} /></div>
          <Show when={status()?.hasApiKey}><Button size="sm" type="button" variant="ghost" onClick={() => { setKey(""); setRemoveKey(!removeKey()); }}>{removeKey() ? "Keep saved key" : "Remove saved key on connect"}</Button></Show>
        </FormSheet>
        <Show when={status()?.configured}><div class="mt-3 border-t border-outline-gray-1 pt-3"><h3 class="text-base-medium">Local execution</h3><div class="mt-2 grid gap-1.5"><For each={status()?.runners}>{(runner) => <p class="break-words text-interface text-ink-gray-7">{runner.id.includes("evaluators") ? "Independent validator" : "Task runner"}: {runner.applied ? "Ready" : runner.connected ? "Applying model settings after the current attempt" : "Waiting for connection"}</p>}</For></div></div></Show>
      </Show>
      <Show when={message()}><p role="status" class="brain-readable mt-3 text-interface">{message()}</p></Show>
      <Show when={error() && !open()}><p role="alert" class="brain-readable mt-3 text-interface text-ink-red-7">{error()}</p></Show>
    </Section>
    <OperationalChecklist />
  </div>;
}
