import { createSignal, Show } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { governor } from "../../data/client";
import { useApp } from "../app-context";
export function DiagnosticExport() {
  const app = useApp(); const [busy, setBusy] = createSignal(false); const [message, setMessage] = createSignal("");
  async function download() {
    setBusy(true); setMessage("");
    try {
      const report = await governor(`/v1/diagnostics?workspaceId=${encodeURIComponent(app.workspaceId())}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "brain-diagnostics.json"; link.click(); URL.revokeObjectURL(url);
      setMessage("Downloaded a diagnostic report containing readiness checks, configuration reference and correlation ID. Credentials, messages and raw logs are excluded.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not export diagnostics."); }
    finally { setBusy(false); }
  }
  return <Section title="Get help" description="Share a redacted diagnostic report with your administrator or support contact." surface="card"><Button size="lg" loading={busy()} onClick={() => void download()}>Download diagnostics</Button><Show when={message()}><p role="status">{message()}</p></Show><details class="mt-4"><summary>Host maintenance</summary><p>On the host, use <code>pnpm brain backup /path/to/backup</code> to stop writers, create and verify a local backup, then restart. Use <code>pnpm brain restore /path/to/backup</code> only after reset or with a fresh data directory; restored execution remains suspended for reconciliation.</p><p><code>pnpm brain reset</code> erases this managed local instance after explicit terminal confirmation. Export any data you need first.</p></details></Section>;
}
