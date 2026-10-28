import { describe, expect, it } from "vitest";
import { TencentDbClient } from "../../../apps/governor/src/modules/knowledge/tencentdb/client";

const URL = process.env["BRAIN_TENCENTDB_URL"] ?? "http://127.0.0.1:8420";

// G04 probe against the standalone TencentDB-Agent-Memory container.
// Skips cleanly when the service is not running.
describe("G04 tencentdb gateway, tenant isolation (E078/E079)", () => {
  it("publishes and searches within tenant; other tenant sees nothing", async () => {
    const client = new TencentDbClient(URL, "local-no-key");
    if (!(await client.health())) {
      console.warn(`TencentDB unreachable at ${URL}; G04 probe skipped`);
      return;
    }
    const marker = `golden-marker-${Date.now()}`;
    const id = await client.publish({ organizationId: "org-g04", userId: "owner-1", sessionId: `s-${Date.now()}`, text: `Brain ${marker} rollout note` });
    expect(id).toBeTruthy();
    const q = {
      contractVersion: "brain.memory/v1" as const, queryId: "g04-1",
      scope: { organizationId: "org-g04", visibility: "workspace" as const, workspaceId: "ws-g04" },
      query: marker, sourceTypes: ["wiki" as const], limit: 5, maxChars: 4000,
    };
    const found = await client.search(q, "owner-1");
    expect(found.some((r) => r.content.includes(marker))).toBe(true);
    const other = await client.search({ ...q, scope: { organizationId: "org-other", visibility: "workspace" as const, workspaceId: "ws-g04" } }, "owner-1");
    expect(other.some((r) => r.content.includes(marker))).toBe(false);
  }, 60_000);
});
