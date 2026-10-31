import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, init, setConfig, writeBlob, writeRef, writeTree } from "isomorphic-git";
import fs from "node:fs";

const author = { name: "Brain Test", email: "brain@example.test", timestamp: 1_700_000_000, timezoneOffset: 0 };

async function initializeBareRepository(root: string): Promise<void> {
  const dir = join(root, "repo.git");
  mkdirSync(dir, { recursive: true });
  await init({ fs, dir, bare: true, defaultBranch: "main" });
  await setConfig({ fs, gitdir: dir, path: "http.receivepack", value: true });
  const blob = await writeBlob({ fs, gitdir: dir, blob: new TextEncoder().encode("initial\n") });
  const tree = await writeTree({ fs, gitdir: dir, tree: [{ path: "README.md", oid: blob, mode: "100644", type: "blob" }] });
  const commitOid = await commit({ fs, gitdir: dir, message: "initial", author, tree, parent: [], ref: "refs/heads/main" });
  await writeRef({ fs, gitdir: dir, ref: "refs/heads/main", value: commitOid, force: true });
  await writeRef({ fs, gitdir: dir, ref: "HEAD", value: "refs/heads/main", symbolic: true, force: true });
}

async function cgi(root: string, request: import("node:http").IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const [pathInfo, queryString = ""] = (request.url ?? "/").split("?");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_HTTP_RECEIVE_PACK: "1",
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const output = new Promise<Buffer>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      else resolve(Buffer.concat(stdout));
    });
  });
  child.stdin.end(body);
  const result = await output;
  const separator = result.indexOf("\r\n\r\n");
  const headerText = result.subarray(0, separator).toString("utf8");
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status: Number(headers["status"]?.split(" ")[0] ?? 200), headers, body: result.subarray(separator + 4) };
}

export async function createGitHttpBackend() {
  const root = mkdtempSync(join(tmpdir(), "brain-git-http-backend-"));
  await initializeBareRepository(root);
  const server: Server = createServer((request, response) => {
    void cgi(root, request).then((result) => {
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    }, (error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "Git backend failed");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Git HTTP backend fixture failed to listen");
  return {
    root,
    remote: `http://127.0.0.1:${address.port}/repo.git`,
    async cleanup(): Promise<void> {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
