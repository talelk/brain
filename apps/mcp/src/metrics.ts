import { z } from "zod";
import { compact } from "./compact";

/** Where Brain's metrics are kept: the host's VictoriaMetrics, behind basic auth. */
export interface MetricsConfig {
  readonly url: string;
  readonly user: string;
  readonly password: string;
}

/** The metric tools: read-only questions put to VictoriaMetrics (MetricsQL, a superset of PromQL). */
export interface MetricTool {
  readonly name: string;
  readonly description: string;
  readonly shape: z.ZodRawShape;
  readonly path: string;
  readonly params: (args: Record<string, unknown>) => Record<string, string>;
}

const text = (value: unknown): string => String(value);
export const METRIC_TOOLS: readonly MetricTool[] = [
  {
    name: "brain_metrics_query", path: "/prometheus/api/v1/query",
    description: "The value of a MetricsQL query now (or at `time`): for example brain_tasks_waiting, sum(brain_tokens_today) or histogram_quantile(0.95, sum by (le) (rate(brain_http_request_duration_seconds_bucket[5m]))). Brain's own series are named brain_*.",
    shape: { query: z.string().min(1).max(2000), time: z.string().optional() },
    params: (args) => ({ query: text(args["query"]), ...(args["time"] === undefined ? {} : { time: text(args["time"]) }) }),
  },
  {
    name: "brain_metrics_range", path: "/prometheus/api/v1/query_range",
    description: "A MetricsQL query over time. `start` and `end` are RFC 3339 times or Unix seconds; `step` is a duration such as 5m. Use it to see a trend (queue depth, tokens, latency) over hours or days.",
    shape: { query: z.string().min(1).max(2000), start: z.string(), end: z.string().optional(), step: z.string().default("5m") },
    params: (args) => ({ query: text(args["query"]), start: text(args["start"]), step: text(args["step"] ?? "5m"), ...(args["end"] === undefined ? {} : { end: text(args["end"]) }) }),
  },
  {
    name: "brain_metrics_names", path: "/prometheus/api/v1/label/__name__/values",
    description: "The names of the metrics that exist, optionally those matching a series selector such as {job=\"brain-governor\"}. Start here to see what Brain reports.",
    shape: { match: z.string().optional() },
    params: (args) => (args["match"] === undefined ? {} : { "match[]": text(args["match"]) }),
  },
];

/** Asks VictoriaMetrics and returns the answer as compact text; a refusal or an error says what the server said. */
export async function askMetrics(config: MetricsConfig, tool: MetricTool, args: Record<string, unknown>): Promise<string> {
  const url = new URL(`${config.url.replace(/\/$/u, "")}${tool.path}`);
  for (const [key, value] of Object.entries(tool.params(args))) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` }, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`VictoriaMetrics answered ${response.status}: ${body.slice(0, 300)}`);
  return compact(JSON.parse(body));
}
