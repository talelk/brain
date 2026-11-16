import { afterEach, describe, expect, it } from "vitest";
import { AcpEngine } from "../../../apps/runner/src/engines/acp";

describe("ACP agent that cannot start", () => {
  const saved = process.env["BRAIN_ACP_COMMAND"];
  afterEach(() => { if (saved === undefined) delete process.env["BRAIN_ACP_COMMAND"]; else process.env["BRAIN_ACP_COMMAND"] = saved; });

  it("probes as unavailable instead of raising an uncaught spawn error", async () => {
    process.env["BRAIN_ACP_COMMAND"] = "/nonexistent/acp-agent";
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => { uncaught.push(error); };
    process.on("uncaughtException", record);
    try {
      const probe = await new AcpEngine().probe();
      expect(probe.features).not.toContain("sessions");
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally { process.off("uncaughtException", record); }
    expect(uncaught).toEqual([]);
  });
});
