import { Show, Suspense, lazy } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { createScopedRead } from "../../data/screens";
import { streamTailQuery } from "../../data/exec-logs";
import { readExecFilters, type ExecLogFilters } from "../exec/exec-filters";
import { tailAxes } from "./LogTail";
import { useApp } from "../app-context";
import { CLOCK_24 } from "../format";

/** The chart engine is heavy: it loads on the Logs route only, after the page is interactive. */
const BarChart = lazy(() => import("@talelk/newui-charts").then((module) => ({ default: module.BarChart })));

const WINDOW = 200;
const BUCKETS = 12;

export interface SeverityBucket { readonly time: string; readonly Info: number; readonly Warning: number; readonly Error: number }

type Tone = "Info" | "Warning" | "Error";
const toneOf = (severity: string | null): Tone => severity === "error" || severity === "critical" ? "Error" : severity === "warning" ? "Warning" : "Info";

/** Counts records per severity over equal slices of the time they span; pure so it can be tested. */
export function bucketSeverity(records: readonly { at: string; severity: string | null }[], buckets = BUCKETS): SeverityBucket[] {
  const stamped = records.map((record) => ({ ms: Date.parse(record.at), tone: toneOf(record.severity) })).filter((record) => Number.isFinite(record.ms));
  if (stamped.length === 0) return [];
  const first = Math.min(...stamped.map((record) => record.ms));
  const last = Math.max(...stamped.map((record) => record.ms));
  const count = last === first ? 1 : buckets;
  const width = (last - first) / count || 1;
  const spanSeconds = (last - first) / 1000;
  const label = (ms: number): string => new Date(ms).toLocaleTimeString([], spanSeconds < 600 ? { ...CLOCK_24, hour: "2-digit", minute: "2-digit", second: "2-digit" } : { ...CLOCK_24, hour: "2-digit", minute: "2-digit" });
  const out = Array.from({ length: count }, (_, index) => ({ time: label(first + index * width), Info: 0, Warning: 0, Error: 0 }));
  for (const record of stamped) {
    const bucket = out[Math.min(count - 1, Math.floor((record.ms - first) / width))]!;
    bucket[record.tone] += 1;
  }
  return out;
}

/**
 * Severity over time for the newest records: a stacked bar chart above the
 * explorer, scoped by the same run/session/attempt/source filters as the list
 * below it (but never by severity, so it always shows the whole picture).
 */
export function SeverityChart(): JSX.Element {
  const app = useApp();
  const [searchParams] = useSearchParams();
  const filters = (): ExecLogFilters => readExecFilters(searchParams);
  const axes = () => { const { severities: _ignored, ...rest } = tailAxes(filters()); return rest; };
  const scopeKey = () => JSON.stringify(axes());
  const read = createScopedRead<{ buckets: SeverityBucket[]; total: number }>({
    scope: app.scope,
    resource: scopeKey,
    load: async (scope, signal) => {
      const base = { workspaceId: scope.workspaceId, ...axes() };
      const probe = await streamTailQuery({ ...base, limit: 1 }, signal);
      const from = Math.max(0, probe.snapshot.head - WINDOW);
      const page = await streamTailQuery({ ...base, ...(from > 0 ? { after: from } : {}), limit: WINDOW }, signal);
      const items = page.snapshot.items;
      return { snapshot: { buckets: bucketSeverity(items.map((item) => ({ at: item.at, severity: item.severity }))), total: items.length }, asOf: page.asOf, sourceWatermark: page.sourceWatermark };
    },
    refreshMs: 15_000,
  });
  const data = () => read.state().data;
  const sum = (tone: Tone) => (data()?.buckets ?? []).reduce((total, bucket) => total + bucket[tone], 0);
  return <section class="rounded-card border border-outline-gray-1 p-3" aria-label="Log severity over time" data-testid="log-severity-chart">
    <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 class="text-base-medium text-ink-gray-9">Activity over time</h2>
      <Show when={data() && data()!.total > 0}>
        <p class="text-caption text-ink-gray-7">Newest {data()!.total} records: {sum("Error")} errors, {sum("Warning")} warnings, {sum("Info")} routine</p>
      </Show>
    </div>
    <Show when={(data()?.buckets.length ?? 0) > 0} fallback={<p class="py-6 text-center text-interface text-ink-gray-6">{read.state().data ? "No log records match these filters yet." : "Loading log activity…"}</p>}>
      <Suspense fallback={<div class="brain-skeleton h-36 rounded-control" aria-hidden="true" />}>
        <BarChart data={data()!.buckets as unknown as Record<string, unknown>[]} x="time" y={["Info", "Warning", "Error"]} stacked height={140} echartOptions={{ grid: { bottom: 22 } }} yAxis={{ min: 0, echartOptions: { minInterval: 1 } }}
          aria-label="Log records per time slice, stacked by severity: routine, warning and error"
          seriesConfig={{ Info: { label: "Routine" }, Warning: { label: "Warnings" }, Error: { label: "Errors" } }} />
      </Suspense>
    </Show>
  </section>;
}
