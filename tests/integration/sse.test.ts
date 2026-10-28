import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { seedHuman, setupWorld } from "../helpers";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 8000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (chunk === null) continue;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes(needle)) return buffer;
  }
  throw new Error(`timed out waiting for ${needle}; got: ${buffer.slice(0, 400)}`);
}

describe("live SSE replay (T06)", () => {
  it("streams new authorized events after the replay cursor and closes on revocation", async () => {
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-sse-")), allowTestActor: true });
    try {
      const brain = app.brain;
      const w = setupWorld(brain);
      const { token, sessionId } = seedHuman(brain, w.org, "owner-1");
      const headers = { authorization: `Bearer ${token}` };

      const ctrl = new AbortController();
      const res = await app.fetch(new Request("http://127.0.0.1:3000/v1/events?live=1&after=0", { headers, signal: ctrl.signal }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: "cmd-sse-1", commandType: "workflow.dispatch",
        workspaceId: w.workspaceId, idempotencyKey: "sse-1",
        payload: { workflow: { id: "fixture-workflow", digest: brain.activeRelease(w.org)!.digest }, input: { message: "live" } },
      }, "sse-corr");
      const seen = await readUntil(reader, "job.queued");
      expect(seen).toContain("id:");
      ctrl.abort();
      await reader.cancel().catch(() => undefined);

      const ctrl2 = new AbortController();
      const res2 = await app.fetch(new Request("http://127.0.0.1:3000/v1/events?live=1&after=0", { headers, signal: ctrl2.signal }));
      const reader2 = res2.body!.getReader();
      brain.store.control.prepare('DELETE FROM "session" WHERE id=?').run(sessionId);
      const closed = await Promise.race([
        (async () => { for (;;) { const c = await reader2.read(); if (c.done) return true; } })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 9000)),
      ]);
      expect(closed).toBe(true);
      ctrl2.abort();
    } finally {
      await app.close();
    }
  }, 30_000);
});
