import { describe, expect, it } from "vitest";
import { engineFailure } from "../../apps/runner/src/engines/run";

/** What an engine's failure is for the task (docs/model.md, "When a task fails"): a model that cannot be reached is not the task's doing, so the attempt is tried again by itself. */
describe("an engine failure", () => {
  it("is infrastructure when the model endpoint could not be reached, in any of the words clients use", () => {
    for (const detail of ["Connection error.", "engine: Connection error.", "fetch failed", "connect ETIMEDOUT 10.0.0.5:8000", "Connect Timeout Error", "read ECONNRESET", "other side closed", "503 Service Unavailable", "getaddrinfo ENOTFOUND model.example"]) {
      expect(engineFailure(detail), detail).toMatchObject({ reason: "engine", infrastructure: true });
    }
  });

  it("is the task's own when the conversation outgrew the model, a tool failed or the answer was not what was asked", () => {
    for (const detail of ["context overflow: 400: maximum context length is 262144 tokens", "tool git.open-pr failed", "the answer is not valid JSON"]) {
      expect(engineFailure(detail), detail).toMatchObject({ reason: "engine", infrastructure: false });
    }
  });

  it("is the endpoint's when it says the window overflowed but no turn of the conversation came near it", () => {
    const detail = "context overflow: 400: maximum context length is 262144 tokens";
    expect(engineFailure(detail, 6_000, 200_000)).toMatchObject({ reason: "engine", infrastructure: true });
    expect(engineFailure(detail, 150_000, 200_000)).toMatchObject({ reason: "engine", infrastructure: false });
  });
});
