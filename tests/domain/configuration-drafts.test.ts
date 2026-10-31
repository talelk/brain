import { describe, expect, it } from "vitest";
import { diffDocuments } from "../../apps/governor/src/modules/configuration/diff";
import { impactDocuments } from "../../apps/governor/src/modules/configuration/impact";
import { normalizeDocuments } from "../../apps/governor/src/modules/configuration/serialize";

describe("configuration draft serialization, diff and impact (T56)", () => {
  it("normalizes confined YAML and produces deterministic diffs and impacted references", () => {
    const active = [
      { path: "workflows/main.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Workflow\nmetadata:\n  id: main\nspec:\n  jobs:\n    echo:\n      kind: dispatch\n      needs: []\n" },
      { path: "tools/echo.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Tool\nmetadata:\n  id: echo\nspec:\n  effectClass: read\n  inputSchemaRef: schemas/in.json\n  outputSchemaRef: schemas/out.json\n" },
    ];
    const draft = [{ path: active[0]!.path, text: active[0]!.text.replace("main", "main-v2") }, active[1]!];
    expect(diffDocuments(active, draft)).toHaveLength(1);
    const impact = impactDocuments(active, draft);
    expect(impact.changedDefinitions).toEqual([
      { kind: "Workflow", id: "main", path: "workflows/main.yaml", change: "removed" },
      { kind: "Workflow", id: "main-v2", path: "workflows/main.yaml", change: "added" },
    ]);
    expect(impact.revalidationRequired).toBe(true);
    expect(impactDocuments(active, active).revalidationRequired).toBe(false);
  });

  it("rejects path escapes and aliases instead of serializing unsafe YAML", () => {
    expect(() => normalizeDocuments([{ path: "../escape.yaml", text: "kind: Workflow" }])).toThrow(/escapes/i);
    expect(() => normalizeDocuments([{ path: "workflows/main.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Workflow\nmetadata:\n  id: main\nspec:\n  jobs:\n    echo:\n      kind: dispatch\n      needs: &needs []\n    other:\n      kind: eval\n      needs: *needs\n" }])).toThrow(/alias/i);
  });
});
