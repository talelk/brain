import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { internalAddress, pruneEgressGrants, removeEgressGrant, startEgressProxy, writeEgressGrant, type EgressProxy } from "../../apps/launcher/src/egress-proxy";
import { scaled } from "../support/timing";

// The egress proxy at its own boundary (ADR 0037, story 105): two fake upstreams on loopback and two grants, as two workspaces' sandboxes
// would hold. What a request may reach is its grant, never the request.
function upstream(name: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`${name} ${req.method} ${req.url} host=${req.headers.host} auth=${req.headers["proxy-authorization"] ?? "none"}`); });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

const basic = (grant: { id: string; token: string }): string => `Basic ${Buffer.from(`${grant.id}:${grant.token}`).toString("base64")}`;

/** A plain-HTTP request through the proxy, in absolute-URI form. */
function viaProxy(proxyPort: number, url: string, authorization?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: url.startsWith("/") ? "proxy" : new URL(url).host, ...(authorization ? { "proxy-authorization": authorization } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT through the proxy, then one GET inside the tunnel; what the proxy answered to CONNECT and, when it opened, what the origin said. */
function tunnel(proxyPort: number, authority: string, authorization?: string): Promise<{ connectStatus: number; inside: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1");
    let text = "";
    let sent = false;
    socket.on("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`));
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (!sent && text.startsWith("HTTP/1.1 200")) { sent = true; text = ""; socket.write(`GET /inside HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`); }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ connectStatus: sent ? 200 : Number(/^HTTP\/1\.1 (\d{3})/u.exec(text)?.[1] ?? 0), inside: sent ? text : "" }));
  });
}

describe("egress proxy (ADR 0037)", () => {
  let dir = "";
  let proxy: EgressProxy;
  const upstreams: Server[] = [];
  let portA = 0;
  let portB = 0;
  let wsA: { id: string; token: string };
  let wsB: { id: string; token: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-egress-"));
    const a = await upstream("alpha");
    const b = await upstream("beta");
    upstreams.push(a.server, b.server);
    portA = a.port;
    portB = b.port;
    wsA = writeEgressGrant(dir, [`127.0.0.1:${portA}`]);
    wsB = writeEgressGrant(dir, [`127.0.0.1:${portB}`]);
    proxy = await startEgressProxy({ port: 0, grantsDir: dir, bindHost: "127.0.0.1", allowInternal: ["127.0.0.1:*", "127.0.0.1"] });
  }, scaled(30_000));

  afterAll(async () => {
    await proxy.close();
    for (const server of upstreams) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a listed host over plain HTTP and says nothing of the proxy credentials to the origin", async () => {
    const answer = await viaProxy(proxy.port, `http://127.0.0.1:${portA}/v1/models?x=1`, basic(wsA));
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(`alpha GET /v1/models?x=1 host=127.0.0.1:${portA} auth=none`);
  });

  it("passes a listed host over CONNECT", async () => {
    const answer = await tunnel(proxy.port, `127.0.0.1:${portB}`, basic(wsB));
    expect(answer.connectStatus).toBe(200);
    expect(answer.inside).toContain("beta GET /inside");
  });

  it("refuses a host that is not listed, over HTTP and over CONNECT, and names it", async () => {
    const http = await viaProxy(proxy.port, "http://127.0.0.1:9/", basic(wsA));
    expect(http.status).toBe(403);
    expect(http.body).toContain("egress denied: 127.0.0.1:9");
    expect((await tunnel(proxy.port, "127.0.0.1:9", basic(wsA))).connectStatus).toBe(403);
    // The host name alone is not enough: the port is part of the entry.
    expect((await viaProxy(proxy.port, `http://localhost:${portA}/`, basic(wsA))).status).toBe(403);
  });

  it("keeps workspaces apart: one grant never reaches what only the other lists", async () => {
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${portB}/`, basic(wsA))).status).toBe(403);
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${portA}/`, basic(wsB))).status).toBe(403);
    expect((await tunnel(proxy.port, `127.0.0.1:${portA}`, basic(wsB))).connectStatus).toBe(403);
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${portB}/`, basic(wsB))).status).toBe(200);
  });

  it("refuses a request with no credentials, a wrong token, an unknown or malformed grant id", async () => {
    const url = `http://127.0.0.1:${portA}/`;
    expect((await viaProxy(proxy.port, url)).status).toBe(407);
    expect((await viaProxy(proxy.port, url, basic({ id: wsA.id, token: "x".repeat(wsA.token.length) }))).status).toBe(407);
    expect((await viaProxy(proxy.port, url, basic({ id: "0".repeat(32), token: wsA.token }))).status).toBe(407);
    expect((await viaProxy(proxy.port, url, basic({ id: "../../etc/passwd", token: "x" }))).status).toBe(407);
    expect((await tunnel(proxy.port, `127.0.0.1:${portA}`)).connectStatus).toBe(407);
  });

  it("refuses a request that is not a proxy request, and https outside CONNECT", async () => {
    expect((await viaProxy(proxy.port, "/relative", basic(wsA))).status).toBe(400);
    expect((await viaProxy(proxy.port, `https://127.0.0.1:${portA}/`, basic(wsA))).status).toBe(400);
  });

  it("an entry without a port allows 80 and 443 only, and a revoked grant stops working", async () => {
    const wide = writeEgressGrant(dir, ["127.0.0.1"]);
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${portA}/`, basic(wide))).status).toBe(403);
    expect((await viaProxy(proxy.port, "http://127.0.0.1:80/", basic(wide))).status).not.toBe(403);
    removeEgressGrant(dir, wsB.id);
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${portB}/`, basic(wsB))).status).toBe(407);
    // A restarted launcher keeps the grants of live sandboxes only.
    expect(pruneEgressGrants(dir, new Set([wsA.id]))).toBe(1);
    expect(readdirSync(dir)).toEqual([`${wsA.id}.json`]);
  });
});

// What a listed name really is (ADR 0037): the address is checked after resolution and the connection pinned to it, so a name cannot be
// pointed at the host, the cloud metadata service or the private network, and cannot change its answer between check and connect.
describe("egress proxy resolves once and refuses internal addresses", () => {
  let dir = "";
  let hits = 0;
  let origin: Server;
  let originPort = 0;
  const proxies: EgressProxy[] = [];
  const dns: Record<string, string[][]> = {};
  const resolutions: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-egress-dns-"));
    origin = createServer((_req, res) => { hits++; res.end("reached"); });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    originPort = (origin.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const proxy of proxies) await proxy.close();
    await new Promise<void>((resolve) => { origin.closeAllConnections(); origin.close(() => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (allowInternal: string[] = []): Promise<EgressProxy> => {
    const proxy = await startEgressProxy({
      port: 0, grantsDir: dir, bindHost: "127.0.0.1", allowInternal,
      resolve: async (host) => { resolutions.push(host); const answer = dns[host]?.shift(); if (!answer) throw new Error("NXDOMAIN"); return answer; },
    });
    proxies.push(proxy);
    return proxy;
  };

  it("refuses names that resolve to loopback, metadata, private and unique-local addresses, in every spelling", async () => {
    const proxy = await start();
    const names: Record<string, string[]> = {
      "loop.example": ["127.0.0.1"], "meta.example": ["169.254.169.254"], "ten.example": ["10.1.2.3"], "private.example": ["192.168.0.9"], "twelve.example": ["172.20.0.2"],
      "six-loop.example": ["::1"], "six-local.example": ["fc00::5"], "six-link.example": ["fe80::1"], "mapped.example": ["::ffff:127.0.0.1"], "mapped-hex.example": ["::ffff:7f00:1"],
      "mapped-meta.example": ["::ffff:169.254.169.254"], "mixed.example": ["203.0.113.9", "10.0.0.1"], "nat64.example": ["64:ff9b::a9fe:a9fe"],
    };
    for (const [name, addresses] of Object.entries(names)) {
      dns[name] = [addresses];
      const grant = writeEgressGrant(dir, [`${name}:${originPort}`]);
      const answer = await viaProxy(proxy.port, `http://${name}:${originPort}/`, basic(grant));
      expect(answer.status, name).toBe(403);
      expect(answer.body, name).toContain("resolves to");
      dns[name] = [addresses];
      expect((await tunnel(proxy.port, `${name}:${originPort}`, basic(grant))).connectStatus, name).toBe(403);
    }
    expect(hits).toBe(0);
  });

  it("refuses an IP literal in a grant that is internal, and the proxy's own address", async () => {
    const proxy = await start();
    for (const literal of ["127.0.0.1", "169.254.169.254", "10.0.0.5"]) {
      const grant = writeEgressGrant(dir, [`${literal}:${originPort}`]);
      expect((await viaProxy(proxy.port, `http://${literal}:${originPort}/`, basic(grant))).status, literal).toBe(403);
    }
    expect(hits).toBe(0);
  });

  it("resolves once and connects to that address, so a name that answers differently the second time cannot redirect it", async () => {
    // The operator listed this host on purpose. The first answer is the origin; a second resolution would give the metadata address.
    const proxy = await start(["rebind.example:*"]);
    dns["rebind.example"] = [["127.0.0.1"], ["169.254.169.254"]];
    resolutions.length = 0;
    const grant = writeEgressGrant(dir, [`rebind.example:${originPort}`]);
    const answer = await viaProxy(proxy.port, `http://rebind.example:${originPort}/`, basic(grant));
    expect(answer).toEqual({ status: 200, body: "reached" });
    expect(resolutions).toEqual(["rebind.example"]);
    expect(hits).toBe(1);
  });

  it("an internal host reaches only through the operator's explicit allowance, and an unresolvable name is a 502", async () => {
    const refused = await start();
    const allowed = await start([`internal.example:${originPort}`]);
    const grant = writeEgressGrant(dir, [`internal.example:${originPort}`, `gone.example:${originPort}`]);
    dns["internal.example"] = [["127.0.0.1"], ["127.0.0.1"]];
    expect((await viaProxy(refused.port, `http://internal.example:${originPort}/`, basic(grant))).status).toBe(403);
    expect((await viaProxy(allowed.port, `http://internal.example:${originPort}/`, basic(grant))).status).toBe(200);
    expect((await viaProxy(allowed.port, `http://gone.example:${originPort}/`, basic(grant))).status).toBe(502);
  });

  it("classifies public addresses as reachable", () => {
    const own = new Set<string>(["172.18.0.3"]);
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "172.32.0.1", "100.63.0.1"]) expect(internalAddress(address, own), address).toBeUndefined();
    for (const address of ["0.0.0.0", "100.64.0.1", "172.31.255.255", "192.0.0.1", "198.19.0.1", "224.0.0.1", "255.255.255.255", "::", "::ffff:10.0.0.1", "ff02::1", "172.18.0.3"]) expect(internalAddress(address, own), address).toBeDefined();
  });
});
