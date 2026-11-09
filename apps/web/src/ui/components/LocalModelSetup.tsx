import { useNavigate } from "@solidjs/router";
import { useApp } from "../app-context";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { Alert, Stepper } from "@talelk/newui-molecules";
import type { LocalRuntimeStatus } from "@brain/contracts";
import { governor } from "../../data/client";
import { OperationalChecklist, createReadiness } from "./OperationalChecklist";
import { TechnicalDetails } from "./PageLayout";
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
  const readiness = createReadiness();
  const taskRunnerReady = () => Boolean(status()?.runners.some((runner) => !runner.id.includes("evaluators") && runner.applied));
  const checksReady = (action: string) => { const items = (readiness.state().data?.checks ?? []).filter((item) => item.action === action); return items.length > 0 && items.every((item) => item.status === "ready"); };
  const modelDone = () => Boolean(status()?.configured && status()?.testedAt) || checksReady("model");
  const runnersDone = () => taskRunnerReady() || checksReady("runners");
  const smokeDone = () => Boolean(readiness.state().data?.smokeVerified);
  const current = () => !modelDone() ? "model" : !runnersDone() ? "runners" : "smoke";
  const allDone = () => modelDone() && runnersDone() && smokeDone();
  const canConfigure = () => Boolean(status()?.enabled);
  const modelButton = () => <Show when={canConfigure()}>
    <Button variant={current() === "model" ? "solid" : "outline"} theme="blue" iconLeft="lucide-plug-zap" onClick={() => { setError(""); setOpen(true); }}>{status()?.configured ? "Change model connection" : "Configure model"}</Button>
  </Show>;
  const stepRow = (id: string, title: string, done: () => boolean, summary: () => JSX.Element, body: () => JSX.Element) => <li class="min-w-0 rounded-card border border-outline-gray-1 px-3 py-2.5" data-step={id} data-state={done() ? "done" : current() === id ? "current" : "upcoming"}>
    <div class="flex min-w-0 items-start gap-2.5">
      <span class={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${done() ? "bg-surface-green-2 text-ink-green-8" : current() === id ? "bg-surface-blue-9 text-white" : "bg-surface-gray-3 text-ink-gray-7"}`}><span class={done() ? "lucide-check size-3" : "lucide-circle size-2"} aria-hidden="true" /></span>
      <div class="min-w-0 flex-1">
        <h3 class={`text-base-medium ${done() || current() === id ? "text-ink-gray-9" : "text-ink-gray-6"}`}>{title}<Show when={done()}><span class="sr-only"> (done)</span></Show></h3>
        <Show when={done()} fallback={<Show when={current() === id}>{body()}</Show>}>{summary()}</Show>
      </div>
    </div>
  </li>;
  const runnerLines = (fallback?: JSX.Element) => <Show when={status()?.configured} fallback={fallback}><div class="mt-1 grid gap-1"><For each={status()?.runners}>{(runner) => <p class="break-words text-interface text-ink-gray-7">{runner.id.includes("evaluators") ? "Independent validator" : "Task runner"}: {runner.applied ? "Ready" : runner.connected ? "Applying model settings after the current attempt" : "Waiting for connection"}</p>}</For></div></Show>;
  return <div class="flex flex-col gap-4">
    <Section title="Models & Providers" description="Three steps to a working workspace. Saved credentials are never returned to the browser." surface="card">
      <div class="flex flex-col gap-4">
        <Stepper label="Setup progress" linear value={current()} steps={[{ value: "model", label: "Connect a model" }, { value: "runners", label: "Start runners" }, { value: "smoke", label: "Run a smoke task" }]} />
        <Show when={allDone()}><Alert theme="green" variant="outline" title="Setup complete" description="A model is connected, runners are ready and a read-only smoke task passed. Brain is ready for real tasks." /></Show>
        <ol class="flex flex-col gap-2">
          {stepRow("model", "Connect a model", modelDone, () => <div class="mt-1 flex flex-wrap items-center justify-between gap-2"><p class="min-w-0 break-all text-interface text-ink-gray-7">{status()?.modelId ? `${status()!.modelId} verified` : "Model verified"}{status()?.testedAt ? ` · ${new Date(status()!.testedAt!).toLocaleString()}` : ""}</p>{modelButton()}</div>, () => <div class="mt-1 flex flex-col items-start gap-2">
            <p class="brain-readable text-interface text-ink-gray-7">Point Brain at an OpenAI-compatible endpoint and the exact model ID. Brain tests both before saving.</p>
            <Show when={canConfigure()} fallback={<p class="brain-readable text-interface text-ink-gray-7">Guided local setup is available when this installation starts with <code>pnpm brain start</code>. Other deployments use their configured runner connections.</p>}>{modelButton()}</Show>
          </div>)}
          {stepRow("runners", "Start the runners", runnersDone, () => runnerLines(<p class="mt-1 text-interface text-ink-gray-7">Runners are online and verified.</p>), () => <div class="mt-1 flex flex-col items-start gap-2">
            <p class="brain-readable text-interface text-ink-gray-7">Local runners start automatically once the model is verified; this can take a minute.</p>
            {runnerLines()}
            <Button variant="solid" theme="blue" iconLeft="lucide-server" onClick={() => void navigate("/runners")}>Open runners</Button>
          </div>)}
          {stepRow("smoke", "Run a smoke task", smokeDone, () => <p class="mt-1 text-interface text-ink-gray-7">The read-only smoke task passed for this connection.</p>, () => <div class="mt-1 flex flex-col items-start gap-2">
            <p class="brain-readable text-interface text-ink-gray-7">A read-only task proves the model, runner and independent validator work together end to end.</p>
            <Button variant="solid" theme="blue" iconLeft="lucide-play" disabled={canConfigure() && !taskRunnerReady()} onClick={() => void navigate(`/plays/agent-smoke`)}>Run read-only smoke task</Button>
          </div>)}
        </ol>
        <div class="flex flex-wrap items-center gap-2 border-t border-outline-gray-1 pt-3"><Button variant={allDone() ? "solid" : "outline"} theme="blue" onClick={() => void navigate(`/w/${app.workspaceId()}/plays?mode=catalog`)}>Explore starter tasks</Button></div>
        <Show when={canConfigure()}>
          <FormSheet open={open()} onClose={() => setOpen(false)} title="Connect a local model" centered description="Brain tests the endpoint and model ID, then starts the local runners with the saved connection."
            submit="Test connection and start runners" icon="lucide-plug-zap" busy={busy()} disabled={!url().trim() || !model().trim()} onSubmit={connect} error={error()} errorTitle="Could not connect to the model">
            <TextInput label="Model API URL" placeholder="http://localhost:8000/v1" description="Use the address reachable from this host, including /v1 when required." value={url()} onInput={(e) => setUrl(e.currentTarget.value)} required disabled={busy()} />
            <TextInput label="Model ID" description="Enter the exact ID advertised by your model server." value={model()} onInput={(e) => setModel(e.currentTarget.value)} required disabled={busy()} />
            <div><TextInput label="Model API key" type="password" autocomplete="off" description={status()?.hasApiKey ? "A key is saved. Leave blank to retain it for the same endpoint." : "Optional for a local endpoint without authentication."} value={key()} onInput={(e) => { setKey(e.currentTarget.value); setRemoveKey(false); }} disabled={busy()} /></div>
            <Show when={status()?.hasApiKey}><Button size="sm" type="button" variant="ghost" onClick={() => { setKey(""); setRemoveKey(!removeKey()); }}>{removeKey() ? "Keep saved key" : "Remove saved key on connect"}</Button></Show>
          </FormSheet>
        </Show>
        <Show when={message()}><p role="status" class="brain-readable text-interface">{message()}</p></Show>
        <Show when={error() && !open()}><p role="alert" class="brain-readable text-interface text-ink-red-7">{error()}</p></Show>
        <TechnicalDetails label="See all checks"><OperationalChecklist check={readiness} /></TechnicalDetails>
      </div>
    </Section>
  </div>;
}
