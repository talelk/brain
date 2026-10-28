import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GitLabConnector } from "../../apps/governor/src/modules/packs/index";

// T41 packet acceptance (wire level): the reference connector talks real
// GitLab REST v4 over a socket to a local mock — auth header, bounded
// responses, rate-limit mapping, and readback reconciliation for the
// no-exactly-once note write. A live GitLab instance remains external.
let server: Server | undefined;
afterEach(async () => { if (server) await new Promise((r) => server!.close(r)); server = undefined; });

interface Seen { method: string; url: string; token: string | undefined; body: string }

async function mockGitLab(notes: Array<{ body: string }>): Promise<{ base: string; seen: Seen[]; setRateLimited: () => void }> {
  const seen: Seen[] = [];
  let rateLimited = false;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c as Buffer)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", token: req.headers["private-token"] as string | undefined, body });
      if (rateLimited) { res.statusCode = 429; res.end("{}"); return; }
      if (req.method === "GET" && req.url === "/api/v4/projects/7") { res.end(JSON.stringify({ id: 7 })); return; }
      if (req.method === "GET" && req.url?.includes("/issues/3/notes")) { res.end(JSON.stringify(notes)); return; }
      if (req.method === "GET" && req.url === "/api/v4/projects/7/issues/3") { res.end(JSON.stringify({ iid: 3, title: "Seed" })); return; }
      if (req.method === "POST" && req.url === "/api/v4/projects/7/issues/3/notes") {
        const parsed = JSON.parse(body) as { body: string };
        notes.push({ body: parsed.body });
        res.statusCode = 201;
        res.end(JSON.stringify({ id: notes.length, body: parsed.body }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, seen, setRateLimited: () => { rateLimited = true; } };
}

describe("gitlab connector over the wire (T41)", () => {
  it("probes, reads, writes a note and reconciles by exact readback", async () => {
    const notes: Array<{ body: string }> = [];
    const { base, seen, setRateLimited } = await mockGitLab(notes);
    const gl = new GitLabConnector(base, 7, "test-token");
    expect((await gl.probe()).reachable).toBe(true);
    expect(await gl.getIssue(3)).toMatchObject({ iid: 3 });
    expect(await gl.reconcileNote(3, "Brain update: deployed")).toEqual({ outcome: "absent" });
    await gl.createNote(3, "Brain update: deployed");
    expect(await gl.reconcileNote(3, "Brain update: deployed")).toEqual({ outcome: "applied" });
    notes.push({ body: "Brain update: deployed" });
    expect(await gl.reconcileNote(3, "Brain update: deployed")).toEqual({ outcome: "conflicting" });
    expect(seen.every((s) => s.token === "test-token")).toBe(true);
    expect(seen.some((s) => s.method === "POST" && s.body.includes("Brain update: deployed"))).toBe(true);
    setRateLimited();
    await expect(gl.getIssue(3)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await gl.probe()).reachable).toBe(false);
    expect(await gl.reconcileNote(3, "x")).toEqual({ outcome: "unknown" });
  }, 60_000);
});
