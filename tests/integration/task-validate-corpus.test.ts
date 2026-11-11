import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The corpus behind the 0.3 word-overlap rule of tools/task.validate (A2 residual): a row the model reworded is accepted at the
 * position of its criterion only when it shares enough of that criterion's words. The rule stays at 0.3 until a corpus of real
 * rewordings shows it refusing honest work; this file records what it accepts and refuses today, so a change is a visible decision.
 */
const CRITERIA = [
  "States, for each checklist item, whether a reader can confirm it without asking anyone",
  "Names the cheaper vendor and the price gap",
  "Lists the assumptions made about seat counts",
];
const BODY = `# Review\n\n${"The review walks through each checklist item and says whether it can be confirmed without asking anyone, then compares the vendors on price. ".repeat(4)}\n\n## Assumptions\n\nSeat counts are equal because none were given.`;
const EVIDENCE = "The Findings section covers this point in detail with figures.";

function judge(rows: string[]): boolean {
  const situation = `Review the guide\nAcceptance criteria:\n${CRITERIA.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}`;
  const report = { summary: "Reviewed.", deliverable: BODY, assumptions: ["Equal seat counts"], criteria: rows.map((criterion) => ({ criterion, met: true, evidence: EVIDENCE })) };
  const result = spawnSync("bash", ["examples/v1/starter-release/tools/task.validate/run.sh"], { input: JSON.stringify({ kind: "general-task", situation, report }), encoding: "utf8" });
  expect(result.status).toBe(0);
  const checks = (JSON.parse(result.stdout) as { checks: Array<{ id: string; passed: boolean }> }).checks;
  return checks.find((check) => check.id === "criteria-met")!.passed;
}

describe("criteria rows the model reworded (the 0.3 overlap rule)", () => {
  const accepted: Array<[string, string[]]> = [
    ["the criteria verbatim", CRITERIA],
    ["case, spacing, punctuation and list numbers changed", ["1. STATES, for each checklist item, whether a reader can confirm it without asking anyone.", "  names the cheaper vendor   and the price gap", "- Lists the assumptions made about seat counts"]],
    ["a light paraphrase of every row", ["For each checklist item, says whether a reader can confirm it without asking anyone", "Names the cheaper vendor and states the price gap", "Lists the assumptions about seat counts"]],
    ["a shortened row that keeps the key words", ["States whether each checklist item can be confirmed without asking anyone", "Names the cheaper vendor", "Assumptions about seat counts"]],
  ];
  const refused: Array<[string, string[]]> = [
    ["rows about something else", ["Something unrelated entirely", "Another unrelated row here", "A third unrelated row here"]],
    ["one row replaced by an unrelated one", [CRITERIA[0]!, "Mentions the weather forecast tomorrow", CRITERIA[2]!]],
    ["one row missing", [CRITERIA[0]!, CRITERIA[1]!]],
    ["one row duplicated for another", [CRITERIA[0]!, CRITERIA[0]!, CRITERIA[2]!]],
  ];
  for (const [name, rows] of accepted) it(`accepts ${name}`, () => expect(judge(rows)).toBe(true));
  for (const [name, rows] of refused) it(`refuses ${name}`, () => expect(judge(rows)).toBe(false));
  // Known looseness, recorded rather than tightened: three-letter stopwords count as shared words, so one shared "the" is 1/3 and passes.
  it("accepts a row that shares only a stopword with its criterion (a known weakness of the rule)", () => expect(judge([CRITERIA[0]!, "Checks the tone", CRITERIA[2]!])).toBe(true));
});
