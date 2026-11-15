// The egress proxy (ADR 0037): the only way a sandbox reaches a network. One process serves every workspace; what a request may reach is the
// grant its own credential names, never anything the request says. The launcher writes one grant per sandbox into a directory the proxy
// reads, and deletes it when the sandbox stops. This file runs by itself in the proxy image (node strips the types), so it imports
// nothing but node built-ins.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** What one sandbox may reach: `host` (ports 80 and 443) or `host:port`, lower-case. */
export interface EgressGrant { readonly token: string; readonly hosts: readonly string[] }

const GRANT_ID = /^[a-f0-9]{32}$/u;
/** One entry of a grant: a lower-case name or IPv4 address with an optional port. The Governor and the launcher both refuse anything else. */
export function isEgressHost(entry: string): boolean {
  const colon = entry.lastIndexOf(":");
  const host = colon < 0 ? entry : entry.slice(0, colon);
  const port = colon < 0 ? undefined : entry.slice(colon + 1);
  const nameOk = host.length >= 1 && host.length <= 253 && /^[a-z0-9.-]+$/u.test(host) && /^[a-z0-9]/u.test(host) && /[a-z0-9]$/u.test(host) && !/\.\.|\.-|-\./u.test(host);
  return nameOk && (port === undefined || (/^[0-9]{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65535));
}

/** The launcher side: a new grant for one sandbox. The id and token become the sandbox's proxy credentials. */
export function writeEgressGrant(dir: string, hosts: readonly string[]): { id: string; token: string } {
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dir, { recursive: true });
  // The proxy runs as another user in its own container, so the file is world-readable; the directory decides who may list it.
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ token, hosts } satisfies EgressGrant), { mode: 0o644 });
  return { id, token };
}

export function removeEgressGrant(dir: string, id: string): void {
  if (!GRANT_ID.test(id)) return;
  try { unlinkSync(join(dir, `${id}.json`)); } catch { /* already gone */ }
}

/** Grants of sandboxes that no longer exist (a launcher restart or crash); the ids to keep are those of the live sandboxes. */
export function pruneEgressGrants(dir: string, keep: ReadonlySet<string>): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/u, "");
    if (GRANT_ID.test(id) && !keep.has(id)) { removeEgressGrant(dir, id); removed++; }
  }
  return removed;
}

function readGrant(dir: string, id: string): EgressGrant | undefined {
  if (!GRANT_ID.test(id)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as Partial<EgressGrant>;
    return typeof parsed.token === "string" && Array.isArray(parsed.hosts) ? { token: parsed.token, hosts: parsed.hosts.filter((host): host is string => typeof host === "string") } : undefined;
  } catch { return undefined; }
}

/** `host` allows ports 80 and 443; `host:port` allows exactly that port. Exact names only: no wildcards, no subdomains. */
function allowed(hosts: readonly string[], host: string, port: number): boolean {
  return hosts.some((entry) => entry === `${host}:${port}` || (entry === host && (port === 80 || port === 443)));
}

type Decision = { ok: true; grantId: string; grant: EgressGrant } | { ok: false; status: 403 | 407; reason: string };

/** The credentials of a request, read against the grants: 407 when there are none or they are wrong. */
function authenticate(dir: string, header: string | undefined): Decision {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/u.exec(header ?? "");
  if (!match) return { ok: false, status: 407, reason: "proxy credentials required" };
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const grantId = colon < 0 ? "" : decoded.slice(0, colon);
  const token = colon < 0 ? "" : decoded.slice(colon + 1);
  const grant = readGrant(dir, grantId);
  const given = Buffer.from(token);
  const wanted = Buffer.from(grant?.token ?? "");
  if (!grant || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, status: 407, reason: "proxy credentials not recognized" };
  return { ok: true, grantId, grant };
}

function target(authority: string, defaultPort: number): { host: string; port: number } | undefined {
  if (/[/@\s]/u.test(authority)) return undefined;
  const colon = authority.lastIndexOf(":");
  const host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase().replace(/\.$/u, "");
  const portText = colon < 0 ? undefined : authority.slice(colon + 1);
  if (!host || host.includes(":") || (portText !== undefined && !/^[0-9]{1,5}$/u.test(portText))) return undefined;
  const port = portText === undefined ? defaultPort : Number(portText);
  return port >= 1 && port <= 65535 ? { host, port } : undefined;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

export interface EgressProxy { readonly port: number; close(): Promise<void> }
export interface EgressProxyOptions { readonly port: number; readonly grantsDir: string; readonly bindHost?: string; readonly log?: (line: string) => void }

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const log = options.log ?? (() => undefined);
  const refuse = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(text), ...(status === 407 ? { "proxy-authenticate": 'Basic realm="brain-egress"' } : {}) });
    res.end(text);
  };
  const refuseSocket = (socket: Socket, status: number, text: string): void => {
    socket.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Forbidden"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="brain-egress"\r\n' : ""}content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
  };

  /** Everything a request needs before a byte leaves: who it is, and whether this grant lists the place it wants. */
  const decide = (authorization: string | undefined, where: { host: string; port: number } | undefined, shown: string): { ok: true; host: string; port: number } | { ok: false; status: number; text: string } => {
    const who = authenticate(options.grantsDir, authorization);
    if (!who.ok) { log(`deny ${who.reason} ${shown}`); return { ok: false, status: who.status, text: `${who.reason}\n` }; }
    if (!where || !allowed(who.grant.hosts, where.host, where.port)) { log(`deny grant=${who.grantId} ${shown}`); return { ok: false, status: 403, text: `egress denied: ${shown}\n` }; }
    log(`allow grant=${who.grantId} ${where.host}:${where.port}`);
    return { ok: true, host: where.host, port: where.port };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A plain-HTTP request to an origin names its absolute URL; https goes through CONNECT, which is the only way a client asks for it.
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { refuse(res, 400, "send absolute-URI requests through the proxy\n"); return; }
    if (url.protocol !== "http:") { refuse(res, 400, "https goes through CONNECT\n"); return; }
    const where = target(url.host, 80);
    const verdict = decide(req.headers["proxy-authorization"], where, url.host);
    if (!verdict.ok) { refuse(res, verdict.status, verdict.text); return; }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    headers["host"] = url.host;
    const upstream = httpRequest({ host: verdict.host, port: verdict.port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: 30_000 }, (answer) => {
      const forwarded: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) forwarded[name] = value;
      res.writeHead(answer.statusCode ?? 502, forwarded);
      answer.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) refuse(res, 502, "upstream unreachable\n"); else res.destroy(); });
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const where = target(req.url ?? "", 443);
    const verdict = decide(req.headers["proxy-authorization"], where, req.url ?? "");
    if (!verdict.ok) { refuseSocket(client, verdict.status, verdict.text); return; }
    let established = false;
    const upstream = connect({ host: verdict.host, port: verdict.port, timeout: 15_000 }, () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.setTimeout(0);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!established && client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); else client.destroy(); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.bindHost ?? "0.0.0.0", resolve); });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// Run as the proxy image's entry point: `node egress-proxy.ts`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const grantsDir = process.env["BRAIN_EGRESS_GRANTS_DIR"] ?? "/grants";
  const running = await startEgressProxy({ port: Number(process.env["BRAIN_PROXY_PORT"] ?? "18080"), grantsDir, log: (line) => console.log(line) });
  console.log(`Brain egress proxy listening on ${running.port}, grants from ${grantsDir}`);
}
