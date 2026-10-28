import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface MatrixRow { id: string; status: "covered" | "partial"; evidence: string }

describe("T50 certification matrix", () => {
  const matrix = JSON.parse(readFileSync(new URL("./coverage.json", import.meta.url), "utf8")) as
    { scenarios: MatrixRow[] };
  const catalog = JSON.parse(readFileSync(new URL("../../contracts/v1/scenario-catalog.json", import.meta.url), "utf8")) as
    { scenarios: { id: string }[] };

  it("maps every E001-E100 scenario exactly once", () => {
    const catalogIds = catalog.scenarios.map((s) => s.id).sort();
    const matrixIds = matrix.scenarios.map((s) => s.id).sort();
    expect(catalogIds).toHaveLength(100);
    expect(matrixIds).toEqual(catalogIds);
  });

  it("covered rows name existing suites that tag the scenario", () => {
    for (const row of matrix.scenarios) {
      expect(row.evidence.length, row.id).toBeGreaterThan(3);
      if (row.status !== "covered") continue;
      const path = new URL(`../../${row.evidence}`, import.meta.url);
      expect(existsSync(path), `${row.id} evidence file`).toBe(true);
      expect(readFileSync(path, "utf8"), `${row.id} tag`).toContain(row.id);
    }
  });
});
