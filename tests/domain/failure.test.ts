import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_TOKEN_CAP, FAILURE_CLASSES, QUOTA_DEFAULT_WAIT_MS, QUOTA_MAX_WAIT_MS, QUOTA_MIN_WAIT_MS, REMEDY, classifyFailure, lessonText, outageLike, quotaWaitMs, waitWords, type FailureSignals } from "../../apps/governor/src/domain/failure";

const base: FailureSignals = { requiredTools: ["host.exec"], agentTools: ["host.exec", "host.read"], calls: { succeeded: 0, failed: 0, outageLike: 0 }, failedChecks: [], earlierSameChecks: 0, tokensUsed: 1000, tokenCap: DEFAULT_TASK_TOKEN_CAP, errorText: "" };

describe("failure classes", () => {
  it("every class has exactly one remedy and the default cap is 200k tokens", () => {
    expect(FAILURE_CLASSES.map((entry) => REMEDY[entry])).toEqual(["switch-way-of-working", "ask-one-question", "stronger-model", "wait-and-retry", "wait-for-quota", "park-budget", "retry"]);
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

  it("a provider's quota or rate limit is its own class, whatever the task needed and whatever the tools showed (ADR 0033)", () => {
    const refused = "agent ended with error: quota or rate limit (retry after 30s): 429: You exceeded your current quota";
    // Even a task that needs a tool and never reached one is a quota, not a model slip.
    expect(classifyFailure({ ...base, errorText: refused })).toBe("quota");
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined, errorText: "model endpoint: RESOURCE_EXHAUSTED: Quota exceeded" })).toBe("quota");
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined, errorText: "HTTP 429 Too Many Requests" })).toBe("quota");
    // The spend cap still comes first; a server error and a number that merely contains 429 are not a quota.
    expect(classifyFailure({ ...base, tokensUsed: DEFAULT_TASK_TOKEN_CAP, errorText: refused })).toBe("budget");
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined, errorText: "model endpoint: 503 service unavailable" })).toBe("tool-outage");
    expect(classifyFailure({ ...base, requiredTools: [], agentTools: undefined, errorText: "wrote 4290 rows" })).toBe("unclassified");
  });

  it("waits the provider's retry-after, bounded: the default with no hint, a floor, a ceiling", () => {
    expect(quotaWaitMs("quota or rate limit (retry after 45s): 429")).toBe(45_000);
    expect(quotaWaitMs("quota or rate limit: 429")).toBe(QUOTA_DEFAULT_WAIT_MS);
    expect(quotaWaitMs("quota or rate limit (retry after 0s): 429")).toBe(QUOTA_MIN_WAIT_MS);
    expect(quotaWaitMs("quota or rate limit (retry after 86400s): 429")).toBe(QUOTA_MAX_WAIT_MS);
    expect(waitWords(45_000)).toBe("45 seconds");
    expect(waitWords(120_000)).toBe("2 minutes");
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
