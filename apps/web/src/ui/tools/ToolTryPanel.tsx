import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { DateText } from "../screen-region";

interface ToolTestView {
  testId: string; runId: string; releaseDigest: string; input: unknown; requestedAt: string;
  state: "running" | "succeeded" | "failed"; output?: unknown; error?: string;
  diagnosis?: { cause: string; headline: string; nextStep: string };
}

const STATE: Record<ToolTestView["state"], { label: string; theme: "green" | "red" | "blue" }> = {
  succeeded: { label: "Passed", theme: "green" }, failed: { label: "Failed", theme: "red" }, running: { label: "Running", theme: "blue" },
};

const preview = (value: unknown): string => {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (cut)` : text;
};

/**
 * Try a read tool with an input you type, and see what it returns or why it failed. The tool runs exactly as it does for an agent
 * (same runner, sandbox and pinned script). Test runs are tagged and kept apart from real calls: they never count in the tool's usage.
 */
export function ToolTryPanel(props: { toolId: string; effectClass: string }): JSX.Element {
  const app = useApp();
  const [text, setText] = createSignal("{}");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const tests = createScopedRead<ToolTestView[]>({
    scope: app.scope,
    resource: () => props.toolId,
    load: async (scope, signal, toolId) => {
      const response = await governor<{ items: ToolTestView[] }>(`/v1/config/tools/${encodeURIComponent(toolId ?? props.toolId)}/tests?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot: response.items, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  async function run(): Promise<void> {
    setError("");
    let input: unknown;
    try { input = JSON.parse(text()); } catch { setError("The input is not valid JSON."); return; }
    if (typeof input !== "object" || input === null || Array.isArray(input)) { setError("The input must be a JSON object, for example {\"url\": \"https://…\"}."); return; }
    setBusy(true);
    try {
      await governor(`/v1/config/tools/${encodeURIComponent(props.toolId)}/test`, { workspaceId: app.scope().workspaceId, input });
      await tests.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The test could not be started."); }
    finally { setBusy(false); }
  }
  return (
    <div class="flex flex-col gap-4" data-tool-try>
      <Show when={props.effectClass === "read"} fallback={<p class="text-interface text-ink-gray-7" data-tool-try-unavailable>Only read tools can be tried here. A {props.effectClass} tool needs an effect permit for each call, which a test never has.</p>}>
        <Textarea label="Input (JSON)" value={text()} onInput={(event) => setText(event.currentTarget.value)} class="min-h-24 min-w-0 max-w-full font-mono" />
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="solid" theme="blue" iconLeft="lucide-play" loading={busy()} disabled={busy()} onClick={() => void run()}>Run test</Button>
          <span class="text-caption text-ink-gray-6">Runs the tool as an agent would. Test runs are tagged and never count in this tool's usage.</span>
        </div>
        <Show when={error()}><Alert theme="red" variant="outline" title="Test not started" description={error()} /></Show>
        <Show when={(tests.state().data ?? []).length > 0}>
          <ul class="flex flex-col divide-y divide-outline-gray-1" data-tool-tests>
            <For each={tests.state().data ?? []}>
              {(test) => (
                <li class="flex flex-col gap-2 py-3" data-tool-test-state={test.state}>
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" theme="gray" label="Test run" />
                    <Badge variant="outline" theme={STATE[test.state].theme} label={STATE[test.state].label} />
                    <DateText value={test.requestedAt} />
                    <A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${test.runId}`}>Open the run</A>
                  </div>
                  <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">Input: {preview(test.input)}</pre>
                  <Show when={test.state === "succeeded" && test.output !== undefined}><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-8" data-tool-test-output>{preview(test.output)}</pre></Show>
                  <Show when={test.error}><p class="break-words text-caption text-ink-gray-8" data-tool-test-error>{test.error}</p></Show>
                  <Show when={test.diagnosis}><p class="text-caption text-ink-gray-7">{test.diagnosis!.headline} <span class="text-ink-gray-6">{test.diagnosis!.nextStep}</span></p></Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
