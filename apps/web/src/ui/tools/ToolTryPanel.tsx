import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { governor } from "../../data/client";
import { startToolSelfTest } from "../../data/engine";
import { createScopedRead } from "../../data/screens";
import { useApp } from "../app-context";
import { DateText } from "../screen-region";
import { t, tOr } from "../../i18n";

interface ToolTestView {
  testId: string; runId: string; releaseDigest: string; input: unknown; requestedAt: string; kind: "try" | "selftest";
  state: "running" | "succeeded" | "failed"; output?: unknown; error?: string;
  diagnosis?: { cause: string; headline: string; nextStep: string };
}
/** What a tool's own test script reports (`kind: "selftest"`). */
interface SelfTestOutput { passed: boolean; exitCode: number; output: string }

const STATE: Record<ToolTestView["state"], { status: string; theme: "green" | "red" | "blue" }> = {
  succeeded: { status: "Passed", theme: "green" }, failed: { status: "Failed", theme: "red" }, running: { status: "Running", theme: "blue" },
};

/** A status word in the interface language. */
const word = (english: string): string => tOr(`status.${english.toLowerCase()}`, english);

const isSelfTestOutput = (value: unknown): value is SelfTestOutput =>
  typeof value === "object" && value !== null && typeof (value as SelfTestOutput).passed === "boolean" && typeof (value as SelfTestOutput).exitCode === "number";

const preview = (value: unknown): string => {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n${t("tools.try.cut")}` : text;
};

/** A self-test row: the script's verdict, its exit code and what it printed. */
function SelfTestResult(props: { test: ToolTestView }): JSX.Element {
  const output = () => isSelfTestOutput(props.test.output) ? props.test.output : undefined;
  const verdict = (): "passed" | "failed" | "running" => output() ? (output()!.passed ? "passed" : "failed") : props.test.state === "running" ? "running" : "failed";
  return <li class="flex flex-col gap-2 py-3" data-tool-test-state={props.test.state} data-tool-test-kind="selftest" data-selftest-verdict={verdict()}>
    <div class="flex flex-wrap items-center gap-2">
      <Badge variant="outline" theme="gray" label={t("tools.selftest.badge")} />
      <Badge variant="outline" theme={verdict() === "passed" ? "green" : verdict() === "failed" ? "red" : "blue"} label={word(verdict() === "passed" ? "Passed" : verdict() === "failed" ? "Failed" : "Running")} />
      <DateText value={props.test.requestedAt} />
      <A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${props.test.runId}`}>{t("tools.try.openRun")}</A>
    </div>
    <Show when={output()}>{(result) => <>
      <p class="m-0 text-caption text-ink-gray-8" data-selftest-summary>{result().passed ? t("tools.selftest.passed", { code: result().exitCode }) : t("tools.selftest.failed", { code: result().exitCode })}</p>
      <Show when={result().output.trim()}><details class="text-caption text-ink-gray-7"><summary class="cursor-pointer">{t("tools.selftest.output")}</summary>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words" data-selftest-output>{result().output.slice(0, 4000)}</pre></details></Show>
    </>}</Show>
    <Show when={!output() && props.test.state === "failed"}><p class="break-words text-caption text-ink-gray-8" data-tool-test-error>{props.test.error ?? t("tools.selftest.noOutput")}</p></Show>
  </li>;
}

/**
 * Try a read tool with an input you type, and see what it returns or why it failed; run any tool's own test script. The tool runs
 * exactly as it does for an agent (same runner, sandbox and pinned script). Test runs are tagged and kept apart from real calls:
 * they never count in the tool's usage.
 */
export function ToolTryPanel(props: { toolId: string; effectClass: string }): JSX.Element {
  const app = useApp();
  const [text, setText] = createSignal("{}");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
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
    try { input = JSON.parse(text()); } catch { setError(t("tools.try.invalidJson")); return; }
    if (typeof input !== "object" || input === null || Array.isArray(input)) { setError(t("tools.try.notObject")); return; }
    setBusy(true);
    try {
      await governor(`/v1/config/tools/${encodeURIComponent(props.toolId)}/test`, { workspaceId: app.scope().workspaceId, input });
      await tests.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("tools.try.couldNotStart")); }
    finally { setBusy(false); }
  }
  async function selfTest(): Promise<void> {
    setError(""); setTesting(true);
    try {
      await startToolSelfTest(props.toolId, app.scope().workspaceId);
      await tests.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("tools.try.couldNotStart")); }
    finally { setTesting(false); }
  }
  return (
    <div class="flex flex-col gap-4" data-tool-try>
      <Show when={props.effectClass === "read"} fallback={<p class="text-interface text-ink-gray-7" data-tool-try-unavailable>{t("tools.try.onlyRead", { class: props.effectClass })}</p>}>
        <Textarea label={t("tools.try.input")} value={text()} onInput={(event) => setText(event.currentTarget.value)} class="min-h-24 min-w-0 max-w-full font-mono" />
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="solid" theme="blue" iconLeft="lucide-play" loading={busy()} disabled={busy()} onClick={() => void run()}>{t("tools.try.run")}</Button>
          <span class="text-caption text-ink-gray-6">{t("tools.try.help")}</span>
        </div>
      </Show>
      <div class="flex flex-col gap-1.5" data-tool-selftest>
        <p class="m-0 text-interface font-medium text-ink-gray-8">{t("tools.selftest.title")}</p>
        <p class="m-0 text-caption text-ink-gray-6">{t("tools.selftest.description")}</p>
        <div><Button variant="outline" iconLeft="lucide-flask-conical" loading={testing()} disabled={testing()} onClick={() => void selfTest()}>{t("tools.selftest.run")}</Button></div>
      </div>
      <Show when={error()}><Alert theme="red" variant="outline" title={t("tools.try.notStarted")} description={error()} /></Show>
      <Show when={(tests.state().data ?? []).length > 0}>
        <ul class="flex flex-col divide-y divide-outline-gray-1" data-tool-tests>
          <For each={tests.state().data ?? []}>
            {(test) => test.kind === "selftest" ? <SelfTestResult test={test} /> : (
              <li class="flex flex-col gap-2 py-3" data-tool-test-state={test.state}>
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" theme="gray" label={t("tools.try.badge")} />
                  <Badge variant="outline" theme={STATE[test.state].theme} label={word(STATE[test.state].status)} />
                  <DateText value={test.requestedAt} />
                  <A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${test.runId}`}>{t("tools.try.openRun")}</A>
                </div>
                <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{t("tools.try.inputLine", { value: preview(test.input) })}</pre>
                <Show when={test.state === "succeeded" && test.output !== undefined}><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-8" data-tool-test-output>{preview(test.output)}</pre></Show>
                <Show when={test.error}><p class="break-words text-caption text-ink-gray-8" data-tool-test-error>{test.error}</p></Show>
                <Show when={test.diagnosis}><p class="text-caption text-ink-gray-7">{test.diagnosis!.headline} <span class="text-ink-gray-6">{test.diagnosis!.nextStep}</span></p></Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
