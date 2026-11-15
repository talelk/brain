import { createHash } from "node:crypto";
import type { Store, EmittedEvent } from "../../application/store";
import { missionTraceId } from "../../domain/trace";

/**
 * Optional trace export (ADR 0066): every event that belongs to a mission becomes one span in that mission's trace (the trace id is the
 * mission trace id the UI shows), sent to an OpenTelemetry collector over OTLP/HTTP JSON. Off unless `OTEL_TRACES_EXPORTER=otlp` and an
 * endpoint are set. The export is written here rather than taken from the OpenTelemetry SDK: those packages are not in the reviewed
 * dependency baseline, and the wire format needed is one JSON document. It never waits for the collector: spans go into a bounded queue,
 * a timer sends them in batches, and a full queue or a failed send drops spans and counts them (`brain_trace_spans_dropped_total`).
 * A span carries event names, ids and states only: attribute values must look like an identifier, so a prompt, an output or a secret
 * cannot ride along.
 */
export interface OtelConfig { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly serviceName: string; readonly timeoutMs: number }

/** The export configuration from the standard OTEL_* variables, or undefined when export is off or the configuration is unusable. */
export function otelConfig(env: NodeJS.ProcessEnv = process.env): OtelConfig | undefined {
  if (env["OTEL_SDK_DISABLED"] === "true") return undefined;
  if (env["OTEL_TRACES_EXPORTER"]?.trim() !== "otlp") return undefined;
  const protocol = env["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"] ?? env["OTEL_EXPORTER_OTLP_PROTOCOL"];
  if (protocol && protocol !== "http/json") return undefined;
  const specific = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  const base = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const raw = specific ?? (base ? `${base.replace(/\/+$/u, "")}/v1/traces` : undefined);
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const headers: Record<string, string> = {};
  for (const pair of (env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] ?? env["OTEL_EXPORTER_OTLP_HEADERS"] ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    try { headers[pair.slice(0, at).trim().toLowerCase()] = decodeURIComponent(pair.slice(at + 1).trim()); } catch { /* a malformed header is skipped */ }
  }
  const timeout = Number(env["OTEL_EXPORTER_OTLP_TRACES_TIMEOUT"] ?? env["OTEL_EXPORTER_OTLP_TIMEOUT"]);
  return { url: url.toString(), headers, serviceName: env["OTEL_SERVICE_NAME"]?.trim() || "brain-governor", timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 5000 };
}

const QUEUE_LIMIT = 1000;
const BATCH_LIMIT = 200;
const FLUSH_MS = 1000;
/** Only these payload fields become attributes, and only when the value looks like an id or a state name. */
const ATTRIBUTE_KEYS = ["missionId", "workItemId", "runId", "attemptId", "jobId", "stepId", "delegationId", "state", "missionState", "jobState"] as const;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/u;

interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; atMs: number; attributes: Record<string, string> }
export interface TraceStats { exported: number; dropped: number; queued: number }

const hex16 = (seed: string): string => createHash("sha256").update(seed).digest("hex").slice(0, 16);
/** The mission's root span id: every other span of the mission is its child. */
export const rootSpanId = (missionId: string): string => hex16(`brain:span:root:${missionId}`);

type Row = Record<string, unknown> | undefined;
/** The mission an event belongs to: named in its payload, or, for a job's events, the mission its run was started for. */
function missionOf(store: Store, e: EmittedEvent): string | undefined {
  const payload = e.payload as Record<string, unknown> | null;
  if (payload && typeof payload === "object" && typeof payload["missionId"] === "string") return payload["missionId"];
  if (e.aggregateType === "mission") return e.aggregateId;
  if (e.aggregateType !== "job" || !e.organizationId || !e.workspaceId) return undefined;
  const job = store.control.prepare("SELECT workflow_run_id FROM jobs WHERE id=?").get(e.aggregateId) as Row;
  const runId = job?.["workflow_run_id"];
  if (typeof runId !== "string") return undefined;
  const link = store.workspaceDb(e.workspaceId, e.organizationId).prepare("SELECT mission_id FROM execution_links WHERE run_id=? LIMIT 1").get(runId) as Row;
  return typeof link?.["mission_id"] === "string" ? link["mission_id"] : undefined;
}

export class TraceExporter {
  private queue: Span[] = [];
  private exported = 0;
  private dropped = 0;
  private sending: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly store: Store, private readonly config: OtelConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** Called for every event the Governor records. Never throws and never waits. */
  observe(e: EmittedEvent): void {
    try {
      const missionId = missionOf(this.store, e);
      if (!missionId) return;
      const traceId = missionTraceId(missionId);
      const payload = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
      const attributes: Record<string, string> = { "brain.event.type": e.eventType, "brain.event.id": e.eventId, "brain.aggregate.type": e.aggregateType, "brain.aggregate.id": e.aggregateId, "brain.mission.id": missionId };
      if (e.workspaceId) attributes["brain.workspace.id"] = e.workspaceId;
      for (const key of ATTRIBUTE_KEYS) { const value = payload[key]; if (typeof value === "string" && IDENTIFIER.test(value)) attributes[`brain.${key}`] = value; }
      if (e.eventType === "mission.created") this.enqueue({ traceId, spanId: rootSpanId(missionId), name: "mission", atMs: e.atMs, attributes: { "brain.mission.id": missionId } });
      this.enqueue({ traceId, spanId: hex16(`brain:span:${e.eventId}`), parentSpanId: rootSpanId(missionId), name: e.eventType, atMs: e.atMs, attributes });
    } catch { /* tracing never disturbs the work */ }
  }

  private enqueue(span: Span): void {
    if (this.queue.length >= QUEUE_LIMIT) { this.dropped += 1; return; }
    this.queue.push(span);
  }

  stats(): TraceStats { return { exported: this.exported, dropped: this.dropped, queued: this.queue.length }; }

  /** Sends what is queued, one batch at a time; resolves when the queue is empty or the collector refused. */
  flush(): Promise<void> {
    this.sending ??= (async () => {
      try {
        while (this.queue.length > 0) {
          const batch = this.queue.splice(0, BATCH_LIMIT);
          if (await this.send(batch)) this.exported += batch.length; else { this.dropped += batch.length; break; }
        }
      } finally { this.sending = undefined; }
    })();
    return this.sending;
  }

  private async send(batch: readonly Span[]): Promise<boolean> {
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const body = { resourceSpans: [{
      resource: { attributes: [attr("service.name", this.config.serviceName)] },
      scopeSpans: [{ scope: { name: "brain.governor" }, spans: batch.map((span) => ({
        traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}), name: span.name, kind: 1,
        startTimeUnixNano: `${span.atMs}000000`, endTimeUnixNano: `${span.atMs}000000`,
        attributes: Object.entries(span.attributes).map(([key, value]) => attr(key, value)),
      })) }],
    }] };
    try {
      const response = await this.fetchImpl(this.config.url, { method: "POST", headers: { ...this.config.headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs) });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch { return false; }
  }

  close(): void {
    clearInterval(this.timer);
    this.queue = [];
  }
}

const exporters = new WeakMap<Store, TraceExporter>();

/** Starts the export for a store when the environment asks for it; the store then feeds it every event. */
export function startTraceExport(store: Store, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): TraceExporter | undefined {
  const config = otelConfig(env);
  if (!config) return undefined;
  const exporter = new TraceExporter(store, config, fetchImpl);
  exporters.set(store, exporter);
  store.eventObserver = (e) => exporter.observe(e);
  return exporter;
}

export const traceStats = (store: Store): TraceStats | undefined => exporters.get(store)?.stats();
