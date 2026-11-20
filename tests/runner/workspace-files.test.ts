import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeWorkspaceFiles } from "../../apps/runner/src/workspace-files";

/** What an agent that reads files is shown of its workspace (docs/model.md, "How work runs"): a read-only copy of the snapshot, bounded, kept inside its folder. */
describe("the workspace copy of an attempt", () => {
  it("holds the snapshot's manifest, prompts, tool files, memory and documents, and leaves out a file that is too big or a path that climbs out", async () => {
    const stored = new Map<string, string>([["sha256:snap", JSON.stringify({
      name: "W", agents: { worker: { prompt: { digest: "sha256:p", bytes: 5 } } }, tools: { "t.a": { files: [{ path: "run.sh", digest: "sha256:r", bytes: 4 }, { path: "../escape.sh", digest: "sha256:e", bytes: 4 }] } },
      memory: [{ name: "note", digest: "sha256:m", bytes: 4 }], documents: [{ path: "docs/big.md", digest: "sha256:big", bytes: 10_000_000 }],
    })], ["sha256:p", "prompt"], ["sha256:r", "run!"], ["sha256:e", "evil"], ["sha256:m", "memo"]]);
    const client = { blob: async (ref: { digest: string }) => new TextEncoder().encode(stored.get(ref.digest) ?? "") };
    const dir = join(mkdtempSync(join(tmpdir(), "ws-")), ".workspace");
    const count = await placeWorkspaceFiles(client as never, "sha256:snap", dir);
    expect(readFileSync(join(dir, "agents/worker/prompt.md"), "utf8")).toBe("prompt");
    expect(readFileSync(join(dir, "tools/t.a/run.sh"), "utf8")).toBe("run!");
    expect(readFileSync(join(dir, "tools/t.a/escape.sh"), "utf8")).toBe("evil");
    expect(readFileSync(join(dir, "memory/note.md"), "utf8")).toBe("memo");
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "docs/big.md"))).toBe(false);
    expect(count).toBe(5);
  });
});
