import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startGovernor } from "./harness";

let started: Awaited<ReturnType<typeof startGovernor>>;
beforeAll(async () => { started = await startGovernor(); });
afterAll(() => started.governor.close());

describe("the Governor's log", () => {
  it("logs an unhandled error with the request id of the response and without its message", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    started.governor.gov.registry.queries.set("setup.status", () => { throw new Error("leaks sk-secret-value"); });
    const response = await started.client().fetch("/v1/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "setup.status", input: {} }) });
    spy.mockRestore();
    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const line = lines.find((entry) => entry.includes("event=request.unhandled")) ?? "";
    expect(line).toContain(`requestId=${requestId}`);
    expect(line).toContain("route=/v1/query");
    expect(lines.join("\n")).not.toContain("sk-secret-value");
    expect(await response.text()).not.toContain("sk-secret-value");
  });
});
