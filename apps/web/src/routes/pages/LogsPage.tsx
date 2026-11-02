import type { JSX } from "solid-js";
import { BrainPage } from "../../ui/components/PageLayout";
import { LogExplorer } from "../../ui/logs/LogExplorer";

/**
 * `/w/:id/logs` — the Log Explorer (T61): an independent, searchable view over
 * the Unified Execution Stream with its own URL. Live tail with pause/resume
 * and an unread counter, source and severity filters, full-text search across
 * authorized retained logs, correlation jumps, tool-call groups, Readable and
 * Raw modes, cross-attempt comparison, bounded sanitized export and error
 * navigation. Filters persist in the URL for deep links.
 */
export default function LogsPage(): JSX.Element {
  return <BrainPage
    title="Logs"
    description="Searchable execution and platform logs over one stream: live tail, correlation jumps, comparison and bounded export.">
    <div class="flex flex-col" style={{ height: "calc(100dvh - 14rem)", "min-height": "36rem" }}>
      <LogExplorer />
    </div>
  </BrainPage>;
}
