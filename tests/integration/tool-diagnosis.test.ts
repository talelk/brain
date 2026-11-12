import { describe, expect, it } from "vitest";
import { diagnoseToolFailure } from "../../apps/governor/src/modules/capabilities/tool-diagnosis";

// Messages copied from the code that produces them (brokers.ts, broker-read.ts, tool-reads.ts, host-commands.ts, invoke.ts, supervisor.ts, host.read run.sh).
describe("tool failure diagnosis", () => {
  it.each([
    ["Agent tool-call budget exhausted", "budget"],
    ["Agent proposed an unauthorized tool or digest", "not-allowed"],
    ["this attempt's agent does not allow web.fetch at that digest", "not-allowed"],
    ["Agent tool input rejected: data must have required property 'url'", "bad-input"],
    ["documentId is required: pass the id of a document of this workspace", "bad-input"],
    ["host example.com is not on this tool's allowlist; only these hosts can be fetched: en.wikipedia.org", "host-not-approved"],
    ["web.fetch has no approved hosts in its pinned definition", "host-not-approved"],
    ["the address is not a public one", "blocked-address"],
    ["that file or folder is not readable through this tool (secrets, databases and backups are kept out)", "path-refused"],
    ["that path is outside the readable area", "path-refused"],
    ["host command rm is not declared by the operator", "command-refused"],
    ["argument container of docker.logs is missing or does not match ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$", "bad-input"],
    ["host commands need the trusted launcher on this runner; none is configured", "no-launcher"],
    ["effect permit is no longer current at the broker boundary; invocation refused", "permit"],
    ["tool exit 2", "script-failed"],
    ["launcher request timed out", "no-launcher"],
    ["content type image/png is not readable text", "unknown"],
  ])("%s -> %s", (message, cause) => {
    expect(diagnoseToolFailure(message).cause).toBe(cause);
  });
  it("says the call never recorded a result when there is no message, and never invents a cause", () => {
    expect(diagnoseToolFailure(undefined).cause).toBe("no-result");
    expect(diagnoseToolFailure("something nobody has seen").cause).toBe("unknown");
  });
});
