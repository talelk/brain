import { describe, expect, it } from "vitest";
import { deriveMissionTitle } from "../../apps/web/src/ui/start/title";

describe("mission title derivation", () => {
  const play = "Compare options and recommend one";
  it("leads with the Play and follows with the sentence", () => {
    expect(deriveMissionTitle("for choosing a shared note-taking tool for a five person team", play))
      .toBe("Compare options and recommend one: a shared note-taking tool for a five person team");
    expect(deriveMissionTitle("about hosting providers.", play)).toBe(`${play}: hosting providers`);
  });
  it("is the Play title alone when no sentence is typed, and never repeats it", () => {
    expect(deriveMissionTitle("", play)).toBe(play);
    expect(deriveMissionTitle("compare options and recommend one for hosting", play)).toBe("Compare options and recommend one for hosting");
  });
  it("capitalises and trims filler without a lead", () => {
    expect(deriveMissionTitle("for choosing a note-taking tool")).toBe("Choosing a note-taking tool");
    expect(deriveMissionTitle("to compare vendors!")).toBe("Compare vendors");
    expect(deriveMissionTitle("please summarise this week's tickets.")).toBe("Summarise this week's tickets");
    expect(deriveMissionTitle("I need you to draft the launch email")).toBe("Draft the launch email");
  });
  it("shortens a long sentence on a word boundary but never cuts the lead", () => {
    const long = deriveMissionTitle("summarise every support ticket from the last quarter and group them by product area and severity for the review");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(73);
    const withLead = deriveMissionTitle("a very long fragment ".repeat(12), play);
    expect(withLead.startsWith(`${play}: `)).toBe(true);
    expect(withLead.length).toBeLessThanOrEqual(92);
  });
  it("uses an earlier mission's title as the lead the same way", () => {
    expect(deriveMissionTitle("for the Q4 numbers", "Weekly churn report")).toBe("Weekly churn report: the Q4 numbers");
  });
});
