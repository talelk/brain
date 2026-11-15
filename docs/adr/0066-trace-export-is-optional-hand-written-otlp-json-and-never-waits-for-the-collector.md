# 66. Trace export is optional, hand-written OTLP/HTTP JSON, and never waits for the collector

Date: 2026-11-15
Status: Accepted (issue #143, spec #90)

**Decision.** When `OTEL_TRACES_EXPORTER=otlp` and an endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) are set, the Governor sends one span for every recorded event that belongs to a mission to the collector over OTLP/HTTP JSON. The mission trace id (ADR on `domain/trace.ts`) is the trace id, so one mission is one trace; a root span `mission` is sent at `mission.created` and every other span is its child. Events of a job (queued, updated) belong to a mission through the run's execution link. Off by default; `OTEL_SDK_DISABLED=true` forces off; only `http/json` is supported (`OTEL_EXPORTER_OTLP_PROTOCOL`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_TIMEOUT` are honoured.

**Why hand-written.** No OpenTelemetry package is in `contracts/v1/dependency-baseline.json` or `docs/dependencies.lock.json`, and the dependency baseline is closed. The wire format needed is one JSON document and one `fetch`, so no SDK is added.

**Never block, never leak.** Events are observed after they are recorded; the observer queues a span and returns. The queue holds 1000 spans; a full queue, a refused batch or an unreachable collector drops spans and counts them (`brain_trace_spans_dropped_total`, with `brain_trace_spans_exported_total`; both exist only while export is on). There is no retry: traces are diagnostics, the event log is the record. A span carries the event type and ids and states only: an attribute value must look like an identifier, so a title, prompt, output or secret cannot ride along. A span can be sent for an event whose transaction later rolls back; that is accepted.

**Alerts.** Platform alerts (a probe turned bad, a stale backup) already reached the owner through the same `deliver` path as attention items, so they use the owner's channel switches (push, webhook in Slack or Teams format, email), the email rate limit and the once-per-bad-spell rule. They now have their own generic words (webhook text, mail subject) instead of the generic "something needs you". Prometheus Alertmanager routing stays optional (`deploy/monitoring/brain-alerts.yml`).

**UI.** The mission trace id is on `Mission.traceId` and `JobSnapshot.context.traceId`, shown copyable on the mission page (Trace id) and the run page (Technical references).
