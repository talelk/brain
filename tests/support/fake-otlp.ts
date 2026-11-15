import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A local OpenTelemetry collector for tests: accepts OTLP/HTTP JSON trace exports and keeps what it was sent. */
export interface FakeOtlpSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: Array<{ key: string; value: { stringValue: string } }> }
export interface FakeOtlp {
  readonly url: string;
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders; body: string }>;
  spans(): FakeOtlpSpan[];
  close(): Promise<void>;
}

export async function startFakeOtlp(): Promise<FakeOtlp> {
  const requests: FakeOtlp["requests"] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { requests.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }); response.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    spans: () => requests.flatMap((r) => (JSON.parse(r.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: FakeOtlpSpan[] }> }> }).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
