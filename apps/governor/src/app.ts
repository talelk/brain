import { BrainError, ERROR_STATUS, hmacSha256Hex, isDigest, MAX_UPLOAD_STRING, parseStrictJson, type ApiError, type Clock } from "@brain/contracts";
import { Hono, type Context } from "hono";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { visibleWorkspaces } from "./access";
import { registerGateway } from "./attempts/gateway";
import { registerAttempts } from "./attempts/routes";
import { offerLocalRunnerToken, registerRunners } from "./attempts/runners";
import { createAuth } from "./auth/auth";
import { ensureSetupToken, registerAuth } from "./auth/handlers";
import { registerUsers } from "./auth/users";
import { openDb } from "./db";
import { errorFields, log } from "./log";
import { Registry, runCommand, runQuery, type Gov } from "./dispatch";
import { onChanged } from "./events";
import { registerHealth } from "./health/health";
import { registerGithub } from "./integrations/github";
import { registerTeams } from "./integrations/teams";
import { registerMemory } from "./memory/memory";
import { registerTasks } from "./tasks/handlers";
import { registerOverview } from "./tasks/overview";
import { registerTriggers } from "./tasks/triggers";
import { registerApprovals } from "./trust/approvals";
import { readableLink, readArtifact } from "./trust/artifacts";
import { checkpoint, ensureAuditKey } from "./trust/audit";
import { registerTrust } from "./trust/handlers";
import { instanceKeys } from "./trust/secrets";
import { registerUsage } from "./trust/usage";
import { registerWorkspace } from "./workspace/handlers";
import { registerPacks, restoreReleases } from "./workspace/packs";
import { reconcile } from "./workspace/store";

export interface GovernorOptions {
  readonly dataDir: string;
  /** The address people reach the Governor at; sign-in cookies and passkeys are bound to it. */
  readonly baseUrl?: string;
  /** The address engines reach the Governor at for the model gateway, when it is not `baseUrl` (a sandbox reaches the host by another name). */
  readonly gatewayUrl?: string;
  readonly packsDir?: string;
  readonly webDist?: string;
  /** Where to leave a one-use runner token while no runner is enrolled (`BRAIN_LOCAL_RUNNER_TOKEN_FILE`): the bundled runner enrols with it, without a person. */
  readonly localRunnerTokenFile?: string;
  readonly clock?: Clock;
  /** Tests answer the Governor's outgoing requests themselves. */
  readonly fetch?: typeof fetch;
}
export interface Governor {
  readonly gov: Gov;
  readonly app: Hono;
  /** Registers work to repeat while the Governor serves (`startTimers`). */
  every(ms: number, work: () => void | Promise<void>): void;
  startTimers(): void;
  close(): void;
}

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const systemClock: Clock = { nowMs: () => Date.now(), monotonicMs: () => performance.now() };
const MAX_BODY = 4 * 1024 * 1024;
/** A command from a signed-in person may carry an upload: a bit over 20 MB of files is about 34 MB as base64, */
const MAX_UPLOAD_BODY = 36 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

/** What the built web app sends: hashed files under /assets never change, so they are kept for a year; text is compressed once per file version and served from memory. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);
const packed = new Map<string, { readonly raw: Buffer; readonly br: Buffer; readonly gzip: Buffer }>();
function staticResponse(file: string, path: string, acceptEncoding: string): Response {
  const type = extname(file);
  const headers: Record<string, string> = { "content-type": TYPES[type] ?? "application/octet-stream", vary: "accept-encoding", "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" };
  if (!COMPRESSIBLE.has(type)) return new Response(Buffer.from(readFileSync(file)), { headers });
  const key = `${file}:${statSync(file).mtimeMs}`;
  let entry = packed.get(key);
  if (!entry) {
    const raw = readFileSync(file);
    entry = { raw, br: brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 7 } }), gzip: gzipSync(raw) };
    packed.set(key, entry);
  }
  const encoding = /\bbr\b/u.test(acceptEncoding) ? "br" : /\bgzip\b/u.test(acceptEncoding) ? "gzip" : undefined;
  if (encoding) headers["content-encoding"] = encoding;
  return new Response(Buffer.from(encoding ? entry[encoding] : entry.raw), { headers });
}

const requestIds = new WeakMap<Request, string>();

function refusal(c: Context, e: unknown): Response {
  const error: ApiError = e instanceof BrainError ? { code: e.code, message: e.message, ...(e.problems ? { problems: e.problems } : {}) } : { code: "INTERNAL", message: "Something went wrong in Brain" };
  const status = ERROR_STATUS[error.code];
  const requestId = requestIds.get(c.req.raw);
  if (status >= 500) log("error", e instanceof BrainError ? "request.failed" : "request.unhandled", { requestId, method: c.req.method, route: c.req.path, status, ...(e instanceof BrainError ? { code: e.code, message: e.message } : errorFields(e)) });
  else if (e instanceof BrainError && e.code === "LEASE_LOST") log("warn", "runner.lease_lost", { requestId, route: c.req.path });
  else if (e instanceof BrainError && c.req.path.startsWith("/runner/") && (status === 401 || status === 403)) log("warn", "runner.rejected", { requestId, route: c.req.path, code: e.code });
  return c.json({ error }, status);
}

/** The body of a request, read as strict JSON. */
export async function readJson(request: Request, upload = false): Promise<unknown> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > (upload ? MAX_UPLOAD_BODY : MAX_BODY)) throw new BrainError("INVALID_INPUT", "The request is too large");
  try {
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), upload ? MAX_UPLOAD_STRING : undefined);
  } catch {
    throw new BrainError("INVALID_INPUT", "The request is not valid JSON");
  }
}

export async function createGovernor(options: GovernorOptions): Promise<Governor> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(join(dataDir, "workspaces"), { recursive: true, mode: 0o700 });
  const baseUrl = options.baseUrl ?? "http://localhost:3100";
  const origin = new URL(baseUrl).origin;
  const db = openDb(dataDir);
  const keys = instanceKeys(dataDir);
  const gov: Gov = {
    db, dataDir, baseUrl, gatewayUrl: (options.gatewayUrl ?? baseUrl).replace(/\/+$/u, ""), keys, packsDir: resolve(options.packsDir ?? repo("packs")), clock: options.clock ?? systemClock, fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    auth: createAuth(db, { secret: hmacSha256Hex(keys.digests, Buffer.from("better-auth")), baseUrl }), registry: new Registry(), onActivate: [], onSignedOut: [],
  };
  const app = new Hono();
  const timers: Array<{ ms: number; work: () => void | Promise<void> }> = [];
  const running = new Set<NodeJS.Timeout>();
  /** The open event streams, each with the person it belongs to. */
  const streams = new Map<() => void, string>();
  const governor: Governor = {
    gov, app,
    every: (ms, work) => void timers.push({ ms, work }),
    startTimers() {
      for (const { ms, work } of timers) running.add(setInterval(() => void Promise.resolve().then(work).catch((e: unknown) => log("error", "timer.failed", errorFields(e))), ms));
    },
    close() {
      for (const timer of running) clearInterval(timer);
      for (const end of [...streams.keys()]) end();
      if (db.open) db.close();
    },
  };
  app.onError((e, c) => refusal(c, e));
  // Every request has an id, sent back as x-request-id and named by the log lines about it.
  app.use("*", async (c, next) => {
    const requestId = randomUUID().slice(0, 8);
    requestIds.set(c.req.raw, requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  // A cookie is sent by the browser on its own, so a request that changes something with one must come from Brain's own pages.
  app.use("*", async (c, next) => {
    const headers = c.req.raw.headers;
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && headers.has("cookie")) {
      const from = headers.get("origin");
      const site = headers.get("sec-fetch-site");
      if (from ? from !== origin : site !== "same-origin" && site !== "none") return refusal(c, new BrainError("FORBIDDEN", "This request did not come from Brain's own pages"));
    }
    return next();
  });

  gov.onSignedOut.push((userId) => { for (const [end, owner] of [...streams]) if (owner === userId) end(); });

  // Sign-in. Accounts are made by setup, by an invitation and by a workspace admin (member.set), so signing up from outside is closed; what changes an
  // account (name, password, sessions) goes through the commands `profile.set`, `session.revoke` and the reset links, which are audited.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    if (c.req.path === "/api/auth/sign-up/email") return refusal(c, new BrainError("FORBIDDEN", "Ask an admin of a workspace to add you"));
    if (/^\/api\/auth\/(?:update-user|change-|delete-user|request-password-reset|reset-password|revoke-|set-password)/u.test(c.req.path)) return refusal(c, new BrainError("FORBIDDEN", "This is done from the Profile page"));
    return gov.auth.handler(c.req.raw);
  });

  /** Where a request came from: the proxy's word when the install trusts one, else the connection. */
  const clientIp = (c: Context): string => {
    if (process.env["BRAIN_AUTH_TRUSTED_PROXIES"]) return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "local";
  };
  const caller = async (c: Context) => ({ user: await gov.auth.user(c.req.raw.headers), cookies: [] as string[], ip: clientIp(c) });
  app.post("/v1/command", async (c) => {
    const who = await caller(c);
    const output = await runCommand(gov, who, await readJson(c.req.raw, who.user !== null));
    for (const cookie of who.cookies) c.header("set-cookie", cookie, { append: true });
    return c.json({ output });
  });
  app.post("/v1/query", async (c) => c.json({ output: await runQuery(gov, await caller(c), await readJson(c.req.raw)) }));

  // One stream per signed-in page: a `changed` frame names a workspace that has something new, and the page reads it again.
  app.get("/v1/events", async (c) => {
    const user = await gov.auth.user(c.req.raw.headers);
    if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const encoder = new TextEncoder();
    let end = (): void => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: string): void => {
          try { controller.enqueue(encoder.encode(frame)); } catch { end(); }
        };
        const stop = onChanged(db, (workspaceIds) => {
          const mine = new Set(visibleWorkspaces(gov, user.id).map((workspace) => workspace.id));
          for (const workspaceId of workspaceIds) if (mine.has(workspaceId)) send(`event: changed\ndata: ${JSON.stringify({ workspaceId })}\n\n`);
        });
        const keepalive = setInterval(() => send(": keepalive\n\n"), 15_000);
        // The stream ends after a while so the page reconnects and its session is checked again.
        const lifetime = setTimeout(() => end(), 5 * 60_000);
        end = () => {
          stop();
          clearInterval(keepalive);
          clearTimeout(lifetime);
          streams.delete(end);
          try { controller.close(); } catch { /* already closed */ }
        };
        streams.set(end, user.id);
        c.req.raw.signal.addEventListener("abort", () => end(), { once: true });
        send(": connected\n\n");
      },
      cancel: () => end(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  });

  app.get("/v1/artifacts/:digest", async (c) => {
    const user = await gov.auth.user(c.req.raw.headers);
    if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const digest = c.req.param("digest");
    const link = isDigest(digest) ? readableLink(gov, digest, user.id) : undefined;
    if (!link) throw new BrainError("NOT_FOUND", "No such file");
    // Stored bytes come from agents: they are downloaded, never rendered as a page of Brain.
    return new Response(Buffer.from(readArtifact(gov, digest)), {
      headers: { "content-type": link.mediaType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(link.name)}`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox" },
    });
  });

  // Each module registers its commands, queries, routes and timers here, before the web app's catch-all route below.
  for (const register of [registerAuth, registerUsers, registerWorkspace, registerPacks, registerTrust, registerUsage, registerApprovals, registerMemory, registerTriggers, registerTasks, registerOverview, registerRunners, registerAttempts, registerGateway, registerGithub, registerTeams, registerHealth]) register(governor);
  governor.every(15 * 60_000, () => void checkpoint(gov));

  ensureAuditKey(gov);
  ensureSetupToken(db, dataDir);
  if (options.localRunnerTokenFile) offerLocalRunnerToken(gov, resolve(options.localRunnerTokenFile));
  await restoreReleases(gov);
  await reconcile(gov);
  log("info", "governor.ready", { dataDir, baseUrl });

  // The built web app, when it is there; any other path is a page of it.
  const dist = resolve(options.webDist ?? repo("apps/web/dist"));
  app.get("*", (c) => {
    if (/^\/(?:v1|runner|api|model|hooks)(?:\/|$)/u.test(c.req.path)) return refusal(c, new BrainError("NOT_FOUND", "There is nothing at this address"));
    const asked = resolve(dist, `.${decodeURIComponent(c.req.path)}`);
    if (c.req.path.startsWith("/assets/") && !(asked.startsWith(dist + sep) && existsSync(asked))) return refusal(c, new BrainError("NOT_FOUND", "There is nothing at this address"));
    const file = asked.startsWith(dist + sep) && existsSync(asked) && statSync(asked).isFile() ? asked : join(dist, "index.html");
    if (!existsSync(file)) return refusal(c, new BrainError("NOT_FOUND", "The web app is not built (pnpm build)"));
    return staticResponse(file, file === asked ? c.req.path : "/", c.req.header("accept-encoding") ?? "");
  });
  app.notFound((c) => refusal(c, new BrainError("NOT_FOUND", "There is nothing at this address")));
  return governor;
}
