import { describe, expect, it } from "vitest";
import { BodyReader, parseJson } from "../../apps/governor/src/http/body";

function streamRequest(body: ReadableStream<Uint8Array>, headers?: Record<string,string>) {
  return new Request("http://localhost/v1/commands", { method: "POST", body, headers, duplex: "half" } as RequestInit & { duplex: "half" });
}

describe("bounded request reading", () => {
  it("stops a chunked body at the byte limit and cancels its source", async () => {
    let pulls = 0; let cancelled = false;
    const request = streamRequest(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } }));
    await expect(new BodyReader(16).read(request, 6)).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(5);
  });

  it("rejects excess declared length, length mismatch and structural expansion", async () => {
    const reader = new BodyReader(1024);
    await expect(reader.read(new Request("http://localhost", { method: "POST", headers: { "content-length":"100" }, body: "small" }), 6)).rejects.toThrow(/byte limit/);
    await expect(reader.read(new Request("http://localhost", { method: "POST", headers: { "content-length":"5" }, body: "a" }), 6)).rejects.toThrow(/mismatch/);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    let nested: unknown = 0; for (let i=0;i<34;i++) nested = { nested };
    expect(() => parseJson(encode(nested))).toThrow(/structure/);
    expect(() => parseJson(encode(Array.from({ length: 10_001 }, () => 0)))).toThrow(/structure/);
    expect(() => parseJson(new Uint8Array([0xff]))).toThrow(/UTF-8/);
  });

  it("reserves admission before reading and releases it after a timeout", async () => {
    let cancelled = false;
    const reader = new BodyReader(8, 20);
    const blocked = reader.read(streamRequest(new ReadableStream({ cancel() { cancelled = true; } })), 8);
    await expect(reader.read(new Request("http://localhost", { method:"POST",body:"x" }), 1)).rejects.toThrow(/capacity/);
    await expect(blocked).rejects.toThrow(/timed out/);
    expect(cancelled).toBe(true);
    expect(await reader.read(new Request("http://localhost", { method:"POST",body:"ok" }), 2)).toEqual(new TextEncoder().encode("ok"));
  });
});
