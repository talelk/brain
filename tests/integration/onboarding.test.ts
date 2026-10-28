import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { setupWorld, type TestWorld } from "../helpers";

// T41 packet acceptance: read-only fact discovery seeds local ticket facts
// idempotently; changed remote facts advance the local version exactly once;
// discovery never writes to the remote system.
let server: Server | undefined;
let world: TestWorld | undefined;
afterEach(async () => {
  world?.brain.close(); world = undefined;
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

async function mockGitLab(issues: Array<Record<string, unknown>>, seen: string[]): Promise<string> {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/api/v4/projects/7") { res.end(JSON.stringify({ id: 7 })); return; }
      if (req.method === "GET" && req.url?.startsWith("/api/v4/projects/7/issues")) { res.end(JSON.stringify(issues)); return; }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("connector onboarding discovery (T41)", () => {
  it("discovers facts idempotently and advances versions only on real change", async () => {
    world = setupWorld();
    const w = world;
    const seen: string[] = [];
    const issues = [
      { iid: 1, title: "Login broken", state: "opened", updated_at: "2026-10-01T00:00:00Z" },
      { iid: 2, title: "Slow dashboard", state: "closed", updated_at: "2026-10-02T00:00:00Z" },
    ];
    const base = await mockGitLab(issues, seen);
    const input = { actor: w.owner, workspaceId: w.workspaceId, baseUrl: base, projectId: 7, token: "t" };
    expect(await w.brain.discoverGitLabFacts(input)).toEqual({ discovered: 2, created: 2, updated: 0, unchanged: 0 });
    expect(await w.brain.discoverGitLabFacts(input)).toEqual({ discovered: 2, created: 0, updated: 0, unchanged: 2 });
    issues[0] = { iid: 1, title: "Login broken (SSO)", state: "opened", updated_at: "2026-10-03T00:00:00Z" };
    expect(await w.brain.discoverGitLabFacts(input)).toEqual({ discovered: 2, created: 0, updated: 1, unchanged: 1 });
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const rows = ws.prepare("SELECT remote_id, title, state, version FROM tickets ORDER BY remote_id").all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { remote_id: "1", title: "Login broken (SSO)", state: "open", version: 2 },
      { remote_id: "2", title: "Slow dashboard", state: "closed", version: 1 },
    ]);
    // Discovery performed no remote writes.
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    // Unreachable project: explicit dependency failure, no partial facts.
    await expect(w.brain.discoverGitLabFacts({ ...input, baseUrl: "http://127.0.0.1:9" })).rejects.toThrow(/not reachable/);
    expect((ws.prepare("SELECT COUNT(*) AS c FROM tickets").get() as { c: number }).c).toBe(2);
  }, 120_000);
});
