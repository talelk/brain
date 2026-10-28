import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, EVENTS, QUERIES, approvalSubjectDigest, canonicalJsonBytes, domainDigest, parseStrictJson } from "@brain/contracts";
import { knownDefinitions, validate } from "@brain/contracts/validate";

describe("contracts (T02)", () => {
  it("exposes the full registry", () => {
    expect(COMMANDS.size).toBe(23);
    expect([...QUERIES]).toEqual(expect.arrayContaining(["agents.list", "agents.get", "workflows.list", "workflows.get"]));
    expect(EVENTS.size).toBeGreaterThan(50);
    const canonical = JSON.parse(readFileSync(join(process.cwd(), "contracts/v1/brain.schema.json"), "utf8")) as { $defs: Record<string,unknown> };
    expect(knownDefinitions()).toEqual(Object.keys(canonical.$defs).sort());
  });

  it("validates example commands and rejects invalid fixtures", () => {
    const ex = JSON.parse(readFileSync(join(process.cwd(), "examples/v1/commands/board.create.json"), "utf8")) as unknown;
    expect(validate("CommandEnvelope", ex).ok).toBe(true);
    expect(validate("CommandEnvelope", { contractVersion: "brain.command/v1" }).ok).toBe(false);
    const bad = JSON.parse(readFileSync(join(process.cwd(), "examples/v1/invalid/unknown-command.json"), "utf8")) as unknown;
    expect(validate("CommandEnvelope", bad).ok).toBe(false);
  });

  it("canonical hashing is order-independent and domain-separated (E014)", () => {
    const a = canonicalJsonBytes({ b: 2, a: 1 } as never);
    const b = canonicalJsonBytes({ a: 1, b: 2 } as never);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(domainDigest("brain:approval:v1", { x: 1 } as never)).not.toBe(domainDigest("brain:other:v1", { x: 1 } as never));
    expect(approvalSubjectDigest({ x: 1 } as never)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("preserves prototype-shaped JSON data and rejects ambiguous or malformed strings", () => {
    const parsed = parseStrictJson('{"__proto__":{"scope":"read"},"constructor":"data"}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(["__proto__", "constructor"]);
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/DUPLICATE/);
    expect(() => parseStrictJson('"raw\nnewline"')).toThrow(/CONTROL/);
    expect(() => parseStrictJson('{"\\ud800":1}')).toThrow(/SURROGATE/);
  });

  it("matches stored canonical vectors", () => {
    const oracles = JSON.parse(readFileSync(join(process.cwd(), "contracts/v1/acceptance-oracles.json"), "utf8")) as {
      canonicalVectors: Array<{ id: string; input?: unknown; rawInput?: string; canonical: string; sha256: string }>;
    };
    expect(oracles.canonicalVectors.length).toBeGreaterThan(0);
    for (const v of oracles.canonicalVectors) {
      const rec = v as unknown as { reject?: string };
      if (rec.reject) {
        expect(() => parseStrictJson(v.rawInput ?? ""), v.id).toThrow();
        continue;
      }
      const input = (v.input ?? JSON.parse(v.rawInput ?? "null")) as never;
      const bytes = canonicalJsonBytes(input);
      expect(new TextDecoder().decode(bytes), v.id).toBe(v.canonical);
    }
  });
});
