import { describe, expect, it } from "vitest";
import { FAILURE_REASON_LIMIT, failureCode, failureReasonOf, redactFailureOutput, redactSecrets } from "../../apps/governor/src/domain/failure-reason";

describe("failure reason", () => {
  it("hides credentials of every shape but keeps the words around them", () => {
    const text = "call failed: Authorization Bearer abcdefghijklmnop1234 and ANTHROPIC_API_KEY=sk-ant-0123456789abcdefghij then password: hunter2 at https://bob:pw@example.test/x with ghp_abcdefghijklmnopqrstuvwx";
    const out = redactSecrets(text);
    for (const leaked of ["abcdefghijklmnop1234", "sk-ant-0123456789abcdefghij", "hunter2", "bob:pw", "ghp_abcdefghijklmnopqrstuvwx"]) expect(out).not.toContain(leaked);
    expect(out).toContain("call failed");
    expect(out).toContain("https://[hidden]@example.test/x");
  });

  it("takes the error of a step output, on one line, at most 500 characters", () => {
    expect(failureReasonOf({ error: "line one\n\n  line two" })).toBe("line one line two");
    expect(failureReasonOf({ ok: false })).toBeUndefined();
    expect(failureReasonOf({ error: "   " })).toBeUndefined();
    expect(failureReasonOf(null)).toBeUndefined();
    const long = failureReasonOf({ error: "x".repeat(2000) })!;
    expect(long).toHaveLength(FAILURE_REASON_LIMIT);
    expect(long.endsWith("…")).toBe(true);
  });

  it("hides credentials in a failed step's stored output, leaving its other fields alone", () => {
    const out = redactFailureOutput({ error: "bad ANTHROPIC_API_KEY=sk-ant-0123456789abcdefghijkl", stderr: "password: hunter2", code: 3 });
    expect(out).toEqual({ error: "bad ANTHROPIC_API_KEY=[hidden]", stderr: "password: [hidden]", code: 3 });
    expect(redactFailureOutput(null)).toBeNull();
    expect(redactFailureOutput([1, 2])).toEqual([1, 2]);
  });

  it("names the kind of failure from its words", () => {
    const missing = "sandboxed execution failed: sandbox create failed 503: docker run failed: Unable to find image 'brain-sandbox-evaluator:latest' locally";
    expect(failureCode(missing)).toBe("sandbox-image-missing");
    expect(failureCode("sandbox create failed 503: Cannot connect to the Docker daemon")).toBe("sandbox-unavailable");
    // A provider's 429 is a quota, never "the model could not be reached" (the cause the runner's "model endpoint" lead used to give it).
    expect(failureCode("agent ended with error: quota or rate limit (retry after 30s): 429: slow down")).toBe("quota");
    expect(failureCode("agent ended with error: model endpoint: 503 service unavailable")).toBe("model-unreachable");
    expect(failureCode("claude is unavailable or its model is unreachable")).toBe("model-unreachable");
    expect(failureCode("the step timed out after 300 seconds")).toBe("timeout");
    expect(failureCode("agent completed without output")).toBe("other");
    expect(failureCode(undefined)).toBe("other");
  });
});
