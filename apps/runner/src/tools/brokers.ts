import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { JsonValue } from "@brain/contracts";

/**
 * Brokers for governed read tools that need data the pinned tool script cannot fetch itself (the script runs without network or Governor
 * access). The supervisor calls a broker after the proposal passed the allowlist, digest, target and schema checks, hands the result to
 * the pinned script as `broker`, and records the call as a tool event with a receipt like any other tool.
 */

export type BrokerResult = { readonly ok: true; readonly data: JsonValue } | { readonly ok: false; readonly error: string };

/** Tools the Governor answers (scope rechecked there); web.fetch is fetched here under the Tool document's host allowlist. */
export const GOVERNOR_BROKERED = new Set(["documents.read", "csv.query", "knowledge.search"]);
export const RUNNER_BROKERED = new Set(["web.fetch"]);

const READABLE_TYPES = [/^text\//u, /^application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|csv|yaml|x-yaml|javascript)(;|$)/u, /\+json(;|$)/u, /\+xml(;|$)/u];

export interface WebFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Tests only: allow loopback and private addresses so a local server can stand in for an approved host. Never set by the supervisor. */
  readonly allowPrivateNetwork?: boolean;
}

/** True for an address a public web page can legitimately be served from; false for loopback, private, link-local, metadata and reserved ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return false;
    if (/^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower) || lower.startsWith("ff")) return false;
    if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}

function hostKey(url: URL): string {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
}

function checkUrl(url: URL, allowedHosts: readonly string[]): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") return `only http and https addresses can be fetched, not ${url.protocol}`;
  if (url.username || url.password) return "addresses with embedded credentials are refused";
  if (!allowedHosts.map((host) => host.toLowerCase()).includes(hostKey(url))) return `host ${hostKey(url)} is not on this tool's allowlist`;
  return undefined;
}

type Fetched = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; truncated: boolean };

function fetchOnce(url: URL, options: Required<Pick<WebFetchOptions, "maxBytes" | "timeoutMs" | "allowPrivateNetwork">>, signal: AbortSignal): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      method: "GET", signal, timeout: options.timeoutMs,
      headers: { accept: "text/*, application/json, application/xml;q=0.9", "user-agent": "Brain-web-fetch/1", "accept-encoding": "identity" },
      // Every connection, including each redirect hop, resolves and checks its address here, so a name that resolves to a private
      // address (or changes its answer between a check and the connection) never reaches the network.
      lookup: (hostname, lookupOptions, callback) => {
        dnsLookup(hostname, { ...lookupOptions, all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error, "", 4);
          const list = (addresses as unknown as Array<{ address: string; family: number }>);
          const usable = list.filter((entry) => options.allowPrivateNetwork || isPublicAddress(entry.address));
          if (usable.length === 0 || usable.length !== list.length) return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EBRAIN_PRIVATE_ADDRESS" }), "", 4);
          if ((lookupOptions as { all?: boolean }).all) return (callback as unknown as (error: null, addresses: unknown) => void)(null, usable);
          return callback(null, usable[0]!.address, usable[0]!.family);
        });
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = options.maxBytes - size;
        if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size = options.maxBytes; truncated = true; response.destroy(); return; }
        chunks.push(chunk); size += chunk.length;
      });
      const done = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), truncated });
      response.on("end", done);
      response.on("close", done);
      response.on("error", (error) => { if (!truncated) reject(error); });
    });
    request.on("timeout", () => request.destroy(new Error(`the host did not answer within ${options.timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

/**
 * GET only, one allowlisted host (re-checked on every redirect), public addresses only, bounded in time and in bytes counted while
 * streaming. The page text is returned with the address it came from; nothing is written anywhere.
 */
export async function webFetch(input: Readonly<Record<string, unknown>>, allowedHosts: readonly string[] | undefined, options: WebFetchOptions = {}): Promise<BrokerResult> {
  if (!allowedHosts || allowedHosts.length === 0) return { ok: false, error: "web.fetch has no approved hosts in its pinned definition" };
  if (typeof input["method"] === "string" && input["method"].toUpperCase() !== "GET") return { ok: false, error: "web.fetch performs GET requests only" };
  let url: URL;
  try { url = new URL(String(input["url"])); } catch { return { ok: false, error: "url is not a valid address" }; }
  const settings = { maxBytes: options.maxBytes ?? 1024 * 1024, timeoutMs: options.timeoutMs ?? 10_000, allowPrivateNetwork: options.allowPrivateNetwork === true };
  const maxRedirects = options.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(settings.timeoutMs * (maxRedirects + 1));
  const original = url.toString();
  try {
    for (let hop = 0; ; hop++) {
      const refused = checkUrl(url, allowedHosts);
      if (refused) return { ok: false, error: hop === 0 ? refused : `a redirect was refused: ${refused}` };
      if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0 && !settings.allowPrivateNetwork && !isPublicAddress(url.hostname.replace(/^\[|\]$/gu, ""))) return { ok: false, error: "the address is not a public one" };
      const fetched = await fetchOnce(url, settings, signal);
      if ([301, 302, 303, 307, 308].includes(fetched.status)) {
        const location = fetched.headers["location"];
        if (typeof location !== "string" || hop >= maxRedirects) return { ok: false, error: hop >= maxRedirects ? "too many redirects" : "a redirect carried no location" };
        url = new URL(location, url);
        continue;
      }
      const contentType = String(fetched.headers["content-type"] ?? "").toLowerCase();
      if (contentType && !READABLE_TYPES.some((pattern) => pattern.test(contentType))) return { ok: false, error: `content type ${contentType.split(";")[0]} is not readable text` };
      return { ok: true, data: { url: original, finalUrl: url.toString(), status: fetched.status, contentType: contentType || "text/plain", fetchedAt: new Date().toISOString(), body: new TextDecoder("utf-8", { fatal: false }).decode(fetched.body), truncated: fetched.truncated } };
    }
  } catch (error) {
    return { ok: false, error: plainFetchError(error, url.hostname) };
  }
}

/**
 * A network failure in words a person can act on. A runner host without outbound access is the usual cause, so that is named; the
 * raw system message (`getaddrinfo EAI_AGAIN`, an empty AggregateError) never reaches the model or the person.
 */
export function plainFetchError(error: unknown, host: string): string {
  const codes = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const { code, errors, cause } = value as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof code === "string") codes.add(code);
    if (Array.isArray(errors)) errors.forEach(collect);
    collect(cause);
  };
  collect(error);
  const message = error instanceof Error ? error.message : "";
  if (codes.has("EBRAIN_PRIVATE_ADDRESS") || /non-public address/u.test(message)) return "the host resolves to a non-public address and was refused";
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN") || codes.has("EAI_FAIL") || codes.has("EAI_NODATA")) return `web.fetch could not look up ${host}: this runner host has no outbound internet access to it, or the name does not exist`;
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT"].some((code) => codes.has(code)) || /did not answer within|timed out|aborted due to timeout/iu.test(message) || (error instanceof Error && error.name === "TimeoutError")) {
    return `web.fetch could not reach ${host}: the connection failed or timed out, which usually means this runner host has no outbound access to it`;
  }
  if (/certificate|CERT_|SSL|TLS/iu.test(`${message} ${[...codes].join(" ")}`)) return `web.fetch could not make a secure connection to ${host}: its certificate was not accepted`;
  return `web.fetch could not read ${host}${message ? ` (${message.slice(0, 160)})` : ""}`;
}
