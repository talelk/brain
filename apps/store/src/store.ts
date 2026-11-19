import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readStoreGrant, STORE_RETENTION_ATTEMPT, type StoreGrant } from "@brain/contracts";

/**
 * The git store (docs/architecture.md, section 8): `git http-backend` over one bare repository per workspace and project, behind a check of the token the
 * Governor signed. It holds the state commits attempts push so the next attempt, on any runner, starts from them. It never calls the Governor.
 *
 * `<root>/<workspace id>/<project>.git` is made on its first request. A token reads every repository of its workspace and creates refs
 * `refs/brain/<goal>/<commit>` under its own goal, each named by the commit it points at and written once: the `update` hook, which reads the grant from the environment this server gives git, refuses
 * every other ref, a rewrite and a deletion. Repositories accept shallow pushes: the store never has a project's history, only what attempts pushed.
 */
export interface StoreOptions {
  /** Where the repositories and the hook live. */
  readonly root: string;
  /** The Governor's public key (PEM) the tokens are checked with, read at each request so a replaced key is used at once. */
  readonly publicKeyPem: () => string;
  /** The most one request may carry (default 1 GiB). */
  readonly maxBytes?: number;
  readonly nowSeconds?: () => number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u;
const PROJECT = /^[a-z][a-z0-9-]{0,62}$/u;
const MAX_BYTES = 1024 * 1024 * 1024;
const ZERO = "0".repeat(40);

/** git sees nothing of the host's configuration. */
const GIT_ENV = { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const HOOK = `#!/bin/sh
# Brain's git store: a token creates refs named by the commit they point at, under its own goal, each once. Anything else is refused.
[ "$1" = "refs/brain/$BRAIN_STORE_GOAL/$3" ] || { echo "this token may push only refs/brain/$BRAIN_STORE_GOAL/<commit>, named by the commit it points at" >&2; exit 1; }
[ "$2" = "${ZERO}" ] || { echo "a state ref is written once" >&2; exit 1; }
[ "$3" != "${ZERO}" ] || { echo "a state ref is never deleted" >&2; exit 1; }
`;

function repositoryOf(root: string, workspaceId: string, project: string): string {
  const path = join(root, "repos", workspaceId, `${project}.git`);
  if (existsSync(join(path, "HEAD"))) return path;
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]): void => { spawnSync("git", args, { env: GIT_ENV, stdio: "ignore" }); };
  git("init", "--quiet", "--bare", path);
  // A repository with no branch has no HEAD to advertise, which some clients (isomorphic-git, the Governor's) cannot do without: it starts with one empty commit.
  const empty = spawnSync("git", ["-C", path, "hash-object", "-w", "-t", "tree", "/dev/null"], { env: GIT_ENV, encoding: "utf8" }).stdout.trim();
  const first = spawnSync("git", ["-C", path, "-c", "user.name=Brain", "-c", "user.email=brain@localhost", "commit-tree", empty, "-m", "Brain git store"], { env: GIT_ENV, encoding: "utf8" }).stdout.trim();
  git("-C", path, "update-ref", "refs/heads/main", first);
  git("-C", path, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const [key, value] of [["receive.shallowUpdate", "true"], ["receive.denyNonFastForwards", "true"], ["receive.denyDeletes", "true"], ["core.hooksPath", join(root, "hooks")], ["http.receivepack", "true"]] as const) git("-C", path, "config", key, value);
  return path;
}

function basicToken(header: string | undefined): string | undefined {
  const [scheme, value] = (header ?? "").split(" ");
  if (scheme?.toLowerCase() === "bearer") return value;
  if (scheme?.toLowerCase() !== "basic" || !value) return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain", ...(status === 401 ? { "www-authenticate": 'Basic realm="Brain git store"' } : {}) }).end(`${message}\n`);
}

/** Forgets every state of a goal in the repositories of a workspace: the refs go, and so do the objects nothing else holds. */
function forget(options: StoreOptions, workspaceId: string, goalId: string, response: ServerResponse): void {
  const base = join(options.root, "repos", workspaceId);
  let deleted = 0;
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    if (!name.endsWith(".git")) continue;
    const repo = join(base, name);
    const listed = spawnSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)", `refs/brain/${goalId}/`], { env: GIT_ENV, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    if (listed.length === 0) continue;
    spawnSync("git", ["-C", repo, "update-ref", "--stdin"], { env: GIT_ENV, input: `${listed.map((ref) => `delete ${ref}`).join("\n")}\n` });
    spawnSync("git", ["-C", repo, "reflog", "expire", "--expire=now", "--all"], { env: GIT_ENV });
    spawnSync("git", ["-C", repo, "gc", "--quiet", "--prune=now"], { env: GIT_ENV });
    deleted += listed.length;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deleted }));
}

function serve(options: StoreOptions, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://store");
  const forgotten = /^\/([^/]+)\/_goals\/([^/]+)$/u.exec(url.pathname);
  if (forgotten && request.method === "DELETE") {
    const token = basicToken(request.headers.authorization);
    const grant = token ? readStoreGrant(token, options.publicKeyPem(), (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()) : undefined;
    if (!grant) return refuse(response, 401, "the token is missing, invalid or expired");
    if (grant.attemptId !== STORE_RETENTION_ATTEMPT || grant.workspaceId !== forgotten[1] || grant.goalId !== forgotten[2] || !NAME.test(grant.workspaceId) || !NAME.test(grant.goalId)) return refuse(response, 403, "the token is not for forgetting this goal");
    return forget(options, grant.workspaceId, grant.goalId, response);
  }
  const where = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/u.exec(url.pathname);
  if (url.pathname === "/health") { response.writeHead(200).end("ok\n"); return; }
  const workspaceId = where?.[1];
  const project = where?.[2];
  if (!where || !workspaceId || !project || !NAME.test(workspaceId) || !PROJECT.test(project)) return refuse(response, 404, "no such repository");
  const token = basicToken(request.headers.authorization);
  const grant: StoreGrant | undefined = token ? readStoreGrant(token, options.publicKeyPem(), (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()) : undefined;
  if (!grant) return refuse(response, 401, "the token is missing, invalid or expired");
  if (grant.workspaceId !== workspaceId) return refuse(response, 403, "the token is for another workspace");
  if (!NAME.test(grant.goalId) || !NAME.test(grant.attemptId)) return refuse(response, 403, "the token names an invalid goal or attempt");
  const length = Number(request.headers["content-length"] ?? 0);
  if (length > (options.maxBytes ?? MAX_BYTES)) return refuse(response, 413, "the push is too large");
  const repos = join(options.root, "repos");
  repositoryOf(options.root, workspaceId, project);

  // The CGI that git itself ships: it reads the request from its environment and standard input and writes headers, a blank line and the body.
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...GIT_ENV, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: grant.attemptId, REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
      REQUEST_METHOD: request.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] ?? "",
      ...(request.headers["content-length"] ? { CONTENT_LENGTH: String(request.headers["content-length"]) } : {}),
      ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"]) } : {}),
      ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
      BRAIN_STORE_GOAL: grant.goalId, BRAIN_STORE_ATTEMPT: grant.attemptId,
    },
  });
  let seen = 0;
  request.on("data", (chunk: Buffer) => { seen += chunk.length; if (seen > (options.maxBytes ?? MAX_BYTES)) { cgi.kill(); request.destroy(); } });
  // git may answer and exit before it has read all of the body; the answer is what counts.
  cgi.stdin.on("error", () => undefined);
  request.pipe(cgi.stdin);
  const head: Buffer[] = [];
  let started = false;
  cgi.stdout.on("data", (chunk: Buffer) => {
    if (started) { response.write(chunk); return; }
    head.push(chunk);
    const all = Buffer.concat(head);
    const split = all.indexOf("\r\n\r\n");
    if (split < 0) return;
    const headers = Object.fromEntries(all.subarray(0, split).toString("latin1").split("\r\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
    const { status = "200", ...rest } = headers;
    response.writeHead(Number(status.split(" ")[0]), rest);
    started = true;
    response.write(all.subarray(split + 4));
  });
  cgi.on("close", () => { if (started) response.end(); else refuse(response, 502, "git did not answer"); });
  response.on("close", () => cgi.kill());
}

export interface Store { readonly server: Server; close(): Promise<void> }

/** Starts the store on `port` (0 for any) of `host`; the hook is written to `<root>/hooks`. */
export async function startStore(options: StoreOptions, port: number, host: string): Promise<Store & { readonly port: number }> {
  mkdirSync(join(options.root, "hooks"), { recursive: true });
  writeFileSync(join(options.root, "hooks", "update"), HOOK);
  chmodSync(join(options.root, "hooks", "update"), 0o755);
  const server = createServer((request, response) => serve(options, request, response));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
