import { describe, expect, it } from "vitest";
import { markdownBlocks, parseInline } from "../../apps/web/src/ui/outputs/markdown-parse";
import { parseStructuredResult, resultMarkdown } from "../../apps/web/src/ui/outputs/result-model";

describe("markdown blocks for task deliverables", () => {
  it("reads headings, paragraphs and rules, wrapping soft line breaks", () => {
    const blocks = markdownBlocks("# Title\n\nFirst line\nsecond line\n\n---\n\n## Next");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "First line second line" },
      { kind: "hr" },
      { kind: "heading", level: 2, text: "Next" },
    ]);
  });

  it("reads a pipe table with alignment and keeps a lone rule as a rule", () => {
    const [table, rule] = markdownBlocks("| Venue | Cost |\n| :--- | ---: |\n| Alpha | 10 |\n| Beta | 12 |\n\n- - -");
    expect(table).toEqual({ kind: "table", header: ["Venue", "Cost"], align: ["left", "right"], rows: [["Alpha", "10"], ["Beta", "12"]] });
    expect(rule).toEqual({ kind: "hr" });
  });

  it("nests bullet and numbered lists by indent", () => {
    const [list] = markdownBlocks("1. one\n   - inner a\n   - inner b\n2. two");
    expect(list).toMatchObject({ kind: "list", list: { ordered: true } });
    const items = (list as { list: { items: { text: string; children: { ordered: boolean; items: { text: string }[] }[] }[] } }).list.items;
    expect(items.map((item) => item.text)).toEqual(["one", "two"]);
    expect(items[0]?.children[0]?.ordered).toBe(false);
    expect(items[0]?.children[0]?.items.map((item) => item.text)).toEqual(["inner a", "inner b"]);
  });

  it("keeps fenced code verbatim and joins quote lines", () => {
    const blocks = markdownBlocks("> a\n> b\n\n```\n# not a heading\n```");
    expect(blocks).toEqual([{ kind: "quote", text: "a b" }, { kind: "code", text: "# not a heading" }]);
  });

  it("parses inline emphasis, code and http links only", () => {
    expect(parseInline("A **bold** and *soft* `code` [site](https://example.com) [bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "A " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "em", text: "soft" },
      { kind: "text", text: " " },
      { kind: "code", text: "code" },
      { kind: "text", text: " " },
      { kind: "link", text: "site", href: "https://example.com" },
      { kind: "text", text: " [bad](javascript:alert(1))" },
    ]);
  });
});

describe("structured task result", () => {
  const stored = JSON.stringify({ summary: "Short.", deliverable: "# Doc\n\nBody", criteria: [{ criterion: "Covers cost", met: true, evidence: "Table" }], assumptions: ["Budget is fixed"] });

  it("is recognised from the stored JSON and anything else stays a plain preview", () => {
    expect(parseStructuredResult(stored)?.criteria).toEqual([{ criterion: "Covers cost", met: true, evidence: "Table" }]);
    expect(parseStructuredResult('{"other":1}')).toBeUndefined();
    expect(parseStructuredResult("not json")).toBeUndefined();
  });

  it("exports the whole result as one Markdown document", () => {
    const markdown = resultMarkdown(parseStructuredResult(stored)!);
    expect(markdown).toContain("> Short.");
    expect(markdown).toContain("# Doc");
    expect(markdown).toContain("- [x] Covers cost (Table)");
    expect(markdown).toContain("- Budget is fixed");
  });
});
