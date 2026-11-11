import { describe, expect, it } from "vitest";
import { auditSentence } from "../../apps/web/src/ui/audit-text";
import { formatDateTime, formatOccurrence, friendlyOutputName } from "../../apps/web/src/ui/format";
import { parseInline } from "../../apps/web/src/ui/outputs/markdown-parse";

describe("UI text policy", () => {
  it("formats dates in English, 24-hour, in the zone asked for, whatever the browser language", () => {
    expect(formatDateTime("2026-11-12T07:05:00Z", "Africa/Tunis")).toBe("12 Nov 2026, 08:05");
    expect(formatOccurrence("2026-11-12T07:00:00Z", "Europe/Paris")).toBe("Thu 12 Nov, 08:00");
    expect(formatDateTime("not a date")).toBe("not a date");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("names outputs by their task title, or spells the plan id out in words", () => {
    expect(friendlyOutputName("write-recommendation", "Write the recommendation")).toBe("Write the recommendation");
    expect(friendlyOutputName("write-recommendation")).toBe("Write recommendation");
    expect(friendlyOutputName("Quarterly Report")).toBe("Quarterly Report");
  });

  it("writes audit entries as plain sentences", () => {
    expect(auditSentence({ action: "tool.read.refused", message: 'A tool request was declined: documents.read for "Draft". no' })).toContain("declined");
    expect(auditSentence({ action: "mission.created", subject: "Q4 plan" })).toBe('Mission "Q4 plan" was started');
    expect(auditSentence({ action: "workItem.parked" })).toBe("Task stopped and is waiting for you");
    expect(auditSentence({ action: "thing.happened-here" })).toBe("Thing happened here");
  });

  it("keeps agent text inline-only: Markdown becomes runs, HTML stays text", () => {
    expect(parseInline("a **b** `c` <img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "a " }, { kind: "strong", text: "b" }, { kind: "text", text: " " }, { kind: "code", text: "c" }, { kind: "text", text: " <img src=x onerror=alert(1)>" },
    ]);
  });
});
