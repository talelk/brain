import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFolder, proveTool } from "../../scripts/pack-check";

/** Every script tool a pack ships proves itself (packs/README.md, "Script tools"), and what it prints fits the outputs it declares. */
const PACKS = fileURLToPath(new URL("../../packs", import.meta.url));
const folders = (path: string): string[] => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
const proofs = folders(PACKS).flatMap((pack) => folders(join(PACKS, pack, "tools")).map((tool) => ({ pack, tool, folder: join(PACKS, pack, "tools", tool) }))).filter(({ folder }) => existsSync(join(folder, "test.sh")));

describe("the tools a pack ships", () => {
  it("have a proof to run", () => {
    expect(proofs.length).toBeGreaterThan(0);
  });

  it.concurrent.each(proofs)("$pack/$tool proves itself", { timeout: 200_000 }, async ({ folder }) => {
    expect(await proveTool(folder)).toMatchObject({ ok: true, problems: [] });
  });
});

describe("brain check", () => {
  it("names a folder's invalid file, a result that does not fit its outputs and a pack that leaves the shape", { timeout: 60_000 }, async () => {
    const pack = mkdtempSync(join(tmpdir(), "brain-draft-"));
    const write = (path: string, content: string): void => { mkdirSync(join(pack, path, ".."), { recursive: true }); writeFileSync(join(pack, path), content); };
    write("pack.toml", 'name = "draft"\nrequires = ["base"]\n');
    write("agents/free/agent.toml", 'description = "Spends without limit."\n');
    write("agents/free/prompt.md", "Work.\n");
    write("tools/count.lines/tool.toml", 'description = "Counts."\neffect = "read"\n[outputs.lines]\ntype = "integer"\nrequired = true\n');
    write("tools/count.lines/run.sh", "#!/usr/bin/env bash\ncat >/dev/null\necho '{\"lines\": \"three\"}'\n");
    write("tools/count.lines/test.sh", '#!/usr/bin/env bash\necho "{}" | bash "$(dirname "$0")/run.sh" >/dev/null\necho "count.lines: ok"\n');
    const checked = await checkFolder(pack, PACKS);
    expect(checked.problems).toEqual([expect.objectContaining({ path: "agents/free/agent.toml" })]);
    expect(checked.proofs).toEqual([expect.objectContaining({ tool: "count.lines", ok: false, problems: [expect.stringContaining('"lines" must be of type integer')] })]);
    rmSync(pack, { recursive: true, force: true });
  });

  it.each(folders(PACKS))("finds nothing wrong with the shipped pack %s", { timeout: 200_000 }, async (pack) => {
    const checked = await checkFolder(join(PACKS, pack), PACKS);
    expect(checked.kind).toBe("pack");
    expect(checked.problems).toEqual([]);
    expect(checked.proofs.filter((proof) => !proof.ok)).toEqual([]);
  });
});
