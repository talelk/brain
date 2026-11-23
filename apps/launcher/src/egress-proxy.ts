// The egress proxy: the only way a sandbox reaches a network. One process serves every workspace; what a request may reach is the
// grant its own credential names, never anything the request says. The launcher writes one grant per sandbox into a directory the proxy
// reads, and deletes it when the sandbox stops. This file runs by itself in the proxy image (node strips the types), so it imports
// nothing but node built-ins.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
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
  if (entry === "*") return true;
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

/** `host` allows ports 80 and 443; `host:port` allows exactly that port; `*` allows any host on ports 80 and 443 (never an internal address). Otherwise exact names only: no subdomains. */
function allowed(hosts: readonly string[], host: string, port: number): boolean {
  return hosts.some((entry) => entry === `${host}:${port}` || ((entry === host || entry === "*") && (port === 80 || port === 443)));
}

/** The IPv4 ranges a sandbox may never reach through an allow-listed name: this host, private, shared, loopback, link-local (cloud metadata), reserved and multicast. */
const INTERNAL_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4Number(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/u.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

/** The eight 16-bit groups of an IPv6 address (an embedded dotted quad included), or undefined when it is not one. */
function v6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted) {
    const n = v4Number(dotted[1]!);
    if (n === undefined) return undefined;
    text = `${text.slice(0, dotted.index)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/** The addresses of this host's own interfaces: the proxy's own (internal) network is never a target. */
function ownAddresses(): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) own.add(entry.address.toLowerCase());
  return own;
}

/**
 * Why an address may not be a target, or undefined when it is a public one: loopback, private (RFC 1918), link-local (169.254.0.0/16,
 * which holds the cloud metadata address), shared, reserved and multicast IPv4; the unspecified, loopback, unique-local, link-local and
 * multicast IPv6; every IPv4 form wrapped in IPv6 (mapped, compatible, NAT64); and an address of the proxy's own interfaces.
 */
export function internalAddress(address: string, own: ReadonlySet<string> = ownAddresses()): string | undefined {
  if (own.has(address.toLowerCase())) return "the proxy's own network";
  const version = isIP(address);
  if (version === 4) {
    const n = v4Number(address)!;
    return INTERNAL_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits))) ? "a private or reserved IPv4 address" : undefined;
  }
  const groups = version === 6 ? v6Groups(address) : undefined;
  if (!groups) return "not an IP address";
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  const upperZero = groups.slice(0, 7).every((group) => group === 0);
  if (groups.every((group) => group === 0) || (upperZero && h === 1)) return "a loopback or unspecified IPv6 address";
  // An IPv4 address wrapped in IPv6 (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d) is judged as the IPv4 address it carries.
  const wrapped = (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) || (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0);
  if (wrapped) return internalAddress(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`, own);
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00) return "a unique-local, link-local or multicast IPv6 address";
  return undefined;
}

/** All addresses a name has now; the first one is the one the connection is pinned to. */
export type Resolver = (host: string) => Promise<readonly string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

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
export interface EgressProxyOptions {
  readonly port: number;
  readonly grantsDir: string;
  readonly bindHost?: string;
  readonly log?: (line: string) => void;
  /** Resolves a name once per request; tests inject a fake DNS. */
  readonly resolve?: Resolver;
  /** Entries (`host`, `host:port` as in a grant, or `host:*` for any port) the operator allows to be internal addresses on purpose; a grant still has to list them. Refused by default. */
  readonly allowInternal?: readonly string[];
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const log = options.log ?? (() => undefined);
  const refuse = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(text), ...(status === 407 ? { "proxy-authenticate": 'Basic realm="brain-egress"' } : {}) });
    res.end(text);
  };
  const refuseSocket = (socket: Socket, status: number, text: string): void => {
    socket.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Forbidden"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="brain-egress"\r\n' : ""}content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
  };

  const resolveHost = options.resolve ?? systemResolver;
  const internalOk = options.allowInternal ?? [];
  /**
   * Everything a request needs before a byte leaves: who it is, whether this grant lists the place it wants, and where that name really
   * is. The name is resolved here once, every address must be public (unless the operator listed the host in `allowInternal`), and the
   * connection is pinned to that address: a second resolution, which a rebinding name could answer differently, never happens.
   */
  const decide = async (authorization: string | undefined, where: { host: string; port: number } | undefined, shown: string): Promise<{ ok: true; host: string; port: number } | { ok: false; status: number; text: string }> => {
    const who = authenticate(options.grantsDir, authorization);
    if (!who.ok) { log(`deny ${who.reason} ${shown}`); return { ok: false, status: who.status, text: `${who.reason}\n` }; }
    if (!where || !allowed(who.grant.hosts, where.host, where.port)) { log(`deny grant=${who.grantId} ${shown}`); return { ok: false, status: 403, text: `egress denied: ${shown}\n` }; }
    let addresses: readonly string[];
    try { addresses = isIP(where.host) ? [where.host] : await resolveHost(where.host); } catch { addresses = []; }
    if (addresses.length === 0) { log(`deny grant=${who.grantId} unresolved ${shown}`); return { ok: false, status: 502, text: `egress failed: ${shown} does not resolve\n` }; }
    if (!internalOk.some((entry) => entry === `${where.host}:*` || allowed([entry], where.host, where.port))) {
      const own = ownAddresses();
      for (const address of addresses) {
        const why = internalAddress(address, own);
        if (why) { log(`deny grant=${who.grantId} ${shown} -> ${address} (${why})`); return { ok: false, status: 403, text: `egress denied: ${shown} resolves to ${why}\n` }; }
      }
    }
    log(`allow grant=${who.grantId} ${where.host}:${where.port} -> ${addresses[0]}`);
    return { ok: true, host: addresses[0]!, port: where.port };
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A plain-HTTP request to an origin names its absolute URL; https goes through CONNECT, which is the only way a client asks for it.
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { refuse(res, 400, "send absolute-URI requests through the proxy\n"); return; }
    if (url.protocol !== "http:") { refuse(res, 400, "https goes through CONNECT\n"); return; }
    const where = target(url.host, 80);
    const verdict = await decide(req.headers["proxy-authorization"], where, url.host);
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

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    client.pause();
    const where = target(req.url ?? "", 443);
    const verdict = await decide(req.headers["proxy-authorization"], where, req.url ?? "");
    if (!verdict.ok) { refuseSocket(client, verdict.status, verdict.text); return; }
    let established = false;
    const upstream = connect({ host: verdict.host, port: verdict.port, timeout: 15_000 }, () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.setTimeout(0);
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
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
  // BRAIN_EGRESS_ALLOW_INTERNAL: comma-separated `host` or `host:port` entries that may resolve to private or loopback addresses (an internal model host the operator grants on purpose). Empty by default.
  const allowInternal = (process.env["BRAIN_EGRESS_ALLOW_INTERNAL"] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const running = await startEgressProxy({ port: Number(process.env["BRAIN_PROXY_PORT"] ?? "18080"), grantsDir, allowInternal, log: (line) => console.log(line) });
  console.log(`Brain egress proxy listening on ${running.port}, grants from ${grantsDir}`);
}
