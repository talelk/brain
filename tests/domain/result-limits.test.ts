import { describe, expect, it } from "vitest";
import { reportedLimits, trustWithLimits } from "../../apps/web/src/ui/outputs/result-model";
import type { StructuredResult, TrustLine } from "../../apps/web/src/ui/outputs/result-model";

const result = (over: Partial<StructuredResult> = {}): StructuredResult => ({ summary: "Found 34 containers.", deliverable: "x".repeat(300), criteria: [{ criterion: "Lists containers", met: true, evidence: "See section one of the report" }], assumptions: [], ...over });
const green: TrustLine = { tone: "green", checked: true, text: "Checked by an independent reviewer: 4 of 4 checks passed" };

describe("a result's reported limits (P1)", () => {
  it("a clean result reports none and keeps its green trust line", () => {
    const limits = reportedLimits(result());
    expect(limits.any).toBe(false);
    expect(trustWithLimits(green, limits)).toBe(green);
  });

  it("assumptions and unmet criteria count as limits", () => {
    const limits = reportedLimits(result({ assumptions: ["Names were inferred"], criteria: [{ criterion: "Reads /srv", met: false, evidence: "No file access" }] }));
    expect(limits).toMatchObject({ any: true, count: 2 });
    expect(limits.unmet).toEqual([{ criterion: "Reads /srv", evidence: "No file access" }]);
  });

  it("a summary that admits it is unverified is a limit even when every criterion is marked met", () => {
    const limits = reportedLimits(result({ summary: "The inventory is built from a document; completeness is unverified and limits are UNKNOWN." }));
    expect(limits.any).toBe(true);
    expect(limits.summaryAdmits).toBe(true);
  });

  it("a passed independent check turns amber, never red, when limits are reported", () => {
    const warned = trustWithLimits(green, reportedLimits(result({ assumptions: ["Paths are inferred"] })));
    expect(warned?.tone).toBe("amber");
    expect(warned?.checked).toBe(true);
    expect(warned?.text).toContain("could not confirm");
  });

  it("leaves red and gray trust lines alone", () => {
    const red: TrustLine = { tone: "red", checked: false, text: "Problems" };
    expect(trustWithLimits(red, reportedLimits(result({ assumptions: ["x"] })))).toBe(red);
    expect(trustWithLimits(undefined, reportedLimits(result()))).toBeUndefined();
  });
});
