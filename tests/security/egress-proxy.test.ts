import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneEgressGrants, removeEgressGrant, startEgressProxy, writeEgressGrant, type EgressProxy } from "../../apps/launcher/src/egress-proxy";
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
    proxy = await startEgressProxy({ port: 0, grantsDir: dir, bindHost: "127.0.0.1" });
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
