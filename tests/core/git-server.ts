import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A git server for one test file: `git http-backend` over the bare repositories in a folder, on a port of this machine, plus the one
 * call of the GitHub API that opens a pull request, answered here and recorded. It is what "the project's repository" and "GitHub" are
 * for a test of pull requests; it stops when the test file asks it to.
 */
export interface GitServer {
  /** `http://127.0.0.1:<port>`; a repository `<root>/<name>.git` is at `<origin>/<name>.git`. */
  readonly origin: string;
  /** Every request, in order: the git ones with the credential they carried, the API ones with their body. */
  readonly requests: Array<{ method: string; path: string; authorization: string; body: string }>;
  /** The pull requests the API was asked to open. */
  readonly opened: Array<{ repo: string; title: string; head: string; base: string; body: string }>;
  close(): Promise<void>;
}

export async function startGitServer(root: string): Promise<GitServer> {
  const requests: GitServer["requests"] = [];
  const opened: GitServer["opened"] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://localhost");
      const api = /^\/api\/v3\/repos\/(.+)\/pulls$/u.exec(url.pathname);
      requests.push({ method: request.method ?? "GET", path: url.pathname, authorization: request.headers.authorization ?? "", body: api ? body.toString("utf8") : "" });
      if (api) {
        const asked = JSON.parse(body.toString("utf8")) as { title: string; head: string; base: string; body: string };
        opened.push({ repo: api[1] ?? "", ...asked });
        response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ number: 40 + opened.length, html_url: `https://github.example/${api[1]}/pull/${40 + opened.length}`, state: "open" }));
        return;
      }
      // The CGI that git itself ships: it reads the request from its environment and standard input and writes headers, a blank line and the body.
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", REMOTE_USER: "test", REMOTE_ADDR: "127.0.0.1",
          REQUEST_METHOD: request.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
          ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}), ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
        },
      });
      const out: Buffer[] = [];
      cgi.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      cgi.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        const headers = Object.fromEntries(all.subarray(0, Math.max(split, 0)).toString("latin1").split("\r\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
        const { status = "200", ...rest } = headers;
        response.writeHead(Number(status.split(" ")[0]), rest).end(split < 0 ? Buffer.alloc(0) : all.subarray(split + 4));
      });
      cgi.stdin.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, opened,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
