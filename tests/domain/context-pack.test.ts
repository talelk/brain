import { describe, expect, it } from "vitest";
import { buildContextPack, estimateTokens, referenceOf, truncateAtSentence, type PackSection } from "../../apps/governor/src/modules/sessions/context-pack";
import { promptWithContext } from "../../apps/runner/src/engines/run";

const identity = { runId: "run-1", jobId: "job-1", workItemId: "wi-1", agentId: "task-worker" };
const sentence = "The analysis compares both options on cost and delivery risk. ";

function sections(noteChars: number, notes = 3): PackSection[] {
  return [
    { id: "brief", title: "Brief", label: "fact", items: [{ id: "goal", text: "Goal: choose a venue", prose: false }, { id: "constraints", text: "Constraints:\n- under 5000 EUR", prose: false }] },
    { id: "decisions", title: "Decisions", label: "fact", items: [{ id: "d1", text: "- Use the north hall", prose: false }] },
    { id: "handoff-notes", title: "Notes", label: "claim", items: Array.from({ length: notes }, (_, index) => ({ id: `n${index}`, text: sentence.repeat(Math.ceil(noteChars / sentence.length)), prose: true })) },
    { id: "last-failure", title: "Failed", label: "fact", items: [{ id: "error", text: "Previous attempt error: the venue API timed out", prose: false }] },
  ];
}

describe("context pack compaction (issue #81)", () => {
  it("keeps everything verbatim when the pack fits", () => {
    const pack = buildContextPack({ sections: sections(300), budgetTokens: 4000, identity });
    expect(pack.manifest.truncations).toEqual([]);
    expect(pack.manifest.overBudget).toBe(false);
    expect(pack.text).toContain("## Notes [claim, not verified]");
    expect(pack.text).not.toContain("truncated");
  });

  it.each([
    { noteChars: 6000, budget: 1500, mode: "truncated" },
    { noteChars: 6000, budget: 300, mode: "referenced" },
  ])("is deterministic and reversible over a $noteChars character body at $budget tokens ($mode)", ({ noteChars, budget, mode }) => {
    const first = buildContextPack({ sections: sections(noteChars), budgetTokens: budget, identity });
    const second = buildContextPack({ sections: sections(noteChars), budgetTokens: budget, identity });
    expect(second.text).toBe(first.text);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.truncations.length).toBeGreaterThan(0);
    expect(first.manifest.truncations.every((entry) => entry.mode === mode || mode === "referenced")).toBe(true);
    for (const entry of first.manifest.truncations) {
      // The reference is the digest of the full text, which the pack keeps so it can be stored and fetched.
      const full = first.bodies.get(entry.reference);
      expect(full).toBeDefined();
      expect(referenceOf(full!)).toBe(entry.reference);
      expect(entry.keptTokens).toBeLessThan(entry.originalTokens);
      expect(first.text).toContain(entry.reference);
    }
    // Facts, decisions and the last failure survive every compaction.
    for (const kept of ["Goal: choose a venue", "under 5000 EUR", "Use the north hall", "the venue API timed out"]) expect(first.text).toContain(kept);
    expect(first.manifest.estimatedTokens).toBe(estimateTokens(first.text));
  });

  it("is a table of section sizes against budgets: the smallest compaction that fits wins", () => {
    const table = [
      { chars: 400, budget: 2000, expected: 0 },
      { chars: 3000, budget: 1200, expected: 3 },
      { chars: 3000, budget: 200, expected: 3 },
    ];
    for (const row of table) {
      const pack = buildContextPack({ sections: sections(row.chars), budgetTokens: row.budget, identity });
      expect(pack.manifest.truncations).toHaveLength(row.expected);
      if (row.expected === 0) expect(pack.manifest.estimatedTokens).toBeLessThanOrEqual(row.budget);
    }
    const mild = buildContextPack({ sections: sections(3000), budgetTokens: 1200, identity });
    const hard = buildContextPack({ sections: sections(3000), budgetTokens: 200, identity });
    expect(mild.manifest.truncations.every((entry) => entry.mode === "truncated")).toBe(true);
    expect(hard.manifest.truncations.every((entry) => entry.mode === "referenced")).toBe(true);
    expect(hard.manifest.overBudget).toBe(false);
    // Facts are never compacted: when they alone exceed the budget the manifest says so.
    expect(buildContextPack({ sections: sections(3000), budgetTokens: 20, identity }).manifest.overBudget).toBe(true);
  });

  it("truncates at a sentence boundary and never invents text", () => {
    const text = `${sentence}${sentence}${sentence}`;
    const cut = truncateAtSentence(text, 100);
    expect(cut.endsWith(".")).toBe(true);
    expect(text.startsWith(cut)).toBe(true);
  });

  it("labels the estimate and prefixes the task without altering it", () => {
    const pack = buildContextPack({ sections: sections(300), budgetTokens: 4000, identity });
    expect(pack.manifest.estimateNote).toMatch(/Estimated/);
    expect(promptWithContext('{"situation":"x"}', { text: pack.text })).toBe(`${pack.text}\n\n# Task\n{"situation":"x"}`);
    expect(promptWithContext('{"situation":"x"}', undefined)).toBe('{"situation":"x"}');
  });
});
