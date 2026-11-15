import { createSignal, Show } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { governor } from "../../data/client";
import { t } from "../../i18n";
import { useApp } from "../app-context";
export function DiagnosticExport() {
  const app = useApp(); const [busy, setBusy] = createSignal(false); const [message, setMessage] = createSignal("");
  async function download() {
    setBusy(true); setMessage("");
    try {
      const report = await governor(`/v1/diagnostics?workspaceId=${encodeURIComponent(app.workspaceId())}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "brain-diagnostics.json"; link.click(); URL.revokeObjectURL(url);
      setMessage(t("health.diagnostics.done"));
    } catch (e) { setMessage(e instanceof Error ? e.message : t("health.diagnostics.failed")); }
    finally { setBusy(false); }
  }
  return <Section title={t("health.diagnostics.title")} description={t("health.diagnostics.description")} surface="card"><div class="flex flex-col items-start gap-3"><Button variant="outline" loading={busy()} onClick={() => void download()}>{t("health.diagnostics.download")}</Button><Show when={message()}><p role="status" class="brain-readable text-interface">{message()}</p></Show><details class="brain-technical-details w-full"><summary class="cursor-pointer text-caption font-medium">Host maintenance</summary><div class="brain-prose mt-2 text-interface text-ink-gray-7"><p>On the host, use <code class="break-all">pnpm brain backup /path/to/backup</code> to stop writers, create and verify a local backup, then restart. Use <code class="break-all">pnpm brain restore /path/to/backup</code> only after reset or with a fresh data directory; restored execution remains suspended for reconciliation.</p><p class="mt-2"><code class="break-all">pnpm brain reset</code> erases this managed local instance after explicit terminal confirmation. Export any data you need first.</p></div></details></div></Section>;
}
