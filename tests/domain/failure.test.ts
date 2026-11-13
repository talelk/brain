import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_TOKEN_CAP, FAILURE_CLASSES, REMEDY, classifyFailure, lessonText, outageLike, type FailureSignals } from "../../apps/governor/src/domain/failure";

const base: FailureSignals = { requiredTools: ["host.exec"], agentTools: ["host.exec", "host.read"], calls: { succeeded: 0, failed: 0, outageLike: 0 }, failedChecks: [], earlierSameChecks: 0, tokensUsed: 1000, tokenCap: DEFAULT_TASK_TOKEN_CAP, errorText: "" };

describe("failure classes", () => {
  it("every class has exactly one remedy and the default cap is 200k tokens", () => {
    expect(FAILURE_CLASSES.map((entry) => REMEDY[entry])).toEqual(["switch-way-of-working", "ask-one-question", "stronger-model", "wait-and-retry", "park-budget", "retry"]);
    expect(new Set(Object.values(REMEDY)).size).toBe(FAILURE_CLASSES.length);
    expect(DEFAULT_TASK_TOKEN_CAP).toBe(200_000);
  });

  it("decides from the record: money, then the tools given, then what happened", () => {
    expect(classifyFailure({ ...base, tokensUsed: DEFAULT_TASK_TOKEN_CAP })).toBe("budget");
    expect(classifyFailure({ ...base, agentTools: ["documents.read"] })).toBe("missing-tool");
    expect(classifyFailure({ ...base, calls: { succeeded: 0, failed: 2, outageLike: 2 } })).toBe("tool-outage");
    expect(classifyFailure({ ...base, calls: { succeeded: 0, failed: 2, outageLike: 1 } })).toBe("unmeetable-criterion");
    expect(classifyFailure({ ...base, calls: { succeeded: 3, failed: 0, outageLike: 0 }, failedChecks: ["criteria-met"], earlierSameChecks: 1 })).toBe("unmeetable-criterion");
    expect(classifyFailure({ ...base, calls: { succeeded: 3, failed: 0, outageLike: 0 }, failedChecks: ["structure"] })).toBe("model-slip");
    expect(classifyFailure({ ...base })).toBe("model-slip"); // the tool was never called
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined })).toBe("unclassified");
  });

  it("recognises outages and malformed answers in plain error text", () => {
    expect(outageLike("sandboxed execution failed")).toBe(true);
    expect(outageLike("that path is outside the readable area")).toBe(false);
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined, errorText: "the model returned invalid JSON" })).toBe("model-slip");
  });

  it("writes one plain lesson per class", () => {
    for (const entry of FAILURE_CLASSES) expect(lessonText(entry, "Check disks", "parked")).toMatch(/^Task "Check disks" was parked; .+\.$/u);
    expect(lessonText("model-slip", "Check disks", "healed")).toContain("failed first and then succeeded");
  });
});
