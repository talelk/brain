import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, commit, init } from "isomorphic-git";
import fs from "node:fs";

const author = { name: "Brain Test", email: "brain@example.test", timestamp: 1_700_000_000, timezoneOffset: 0 };

function packet(value: string): string {
  return `${(value.length + 4).toString(16).padStart(4, "0")}${value}`;
}

export async function createGitRemote() {
  const root = mkdtempSync(join(tmpdir(), "brain-isomorphic-remote-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  await init({ fs, dir: source, defaultBranch: "main" });
  writeFileSync(join(source, "README.md"), "initial\n");
  await add({ fs, dir: source, filepath: "README.md" });
  let currentOid = await commit({ fs, dir: source, message: "initial", author });
  let refs = { HEAD: currentOid, "refs/heads/main": currentOid };
  const server: Server = createServer((request, response) => {
    const receive = request.url?.includes("git-receive-pack") ?? false;
    const service = receive ? "git-receive-pack" : "git-upload-pack";
    const capabilities = receive ? "report-status delete-refs" : "multi_ack_detailed no-done side-band-64k thin-pack ofs-delta agent=brain-test";
    const body = `${packet(`# service=${service}\n`)}0000${packet(`${currentOid} HEAD\0${capabilities}\n`)}${packet(`${currentOid} refs/heads/main\n`)}0000`;
    response.writeHead(200, { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Git fixture failed to listen");
  refs = { HEAD: currentOid, "refs/heads/main": currentOid };
  return {
    root,
    remote: `http://127.0.0.1:${address.port}/repo.git`,
    currentRefs: () => refs,
    async update(text: string): Promise<void> {
      writeFileSync(join(source, "README.md"), text);
      await add({ fs, dir: source, filepath: "README.md" });
      currentOid = await commit({ fs, dir: source, message: text.trim(), author });
      refs = { HEAD: currentOid, "refs/heads/main": currentOid };
    },
    async cleanup(): Promise<void> {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
