import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";

/** GET /metrics (docs/architecture.md section 9): absent without a token, closed to a request that came through a proxy, and the measures in Prometheus text. */
let harness: Harness;
beforeAll(async () => { harness = await createHarness(); });
afterAll(() => harness.close());
afterEach(() => { delete process.env["BRAIN_METRICS_TOKEN"]; });

const scrape = (headers: Record<string, string> = {}) => harness.anonymous.fetch("/metrics", { headers });
const bearer = { authorization: "Bearer scrape-token-123" };

describe("metrics", () => {
  it("answers 404 while no token is set, even to a request that sends one", async () => {
    expect((await scrape(bearer)).status).toBe(404);
  });

  it("asks for the bearer token, and answers a request that came through the proxy with 404 even then", async () => {
    process.env["BRAIN_METRICS_TOKEN"] = "scrape-token-123";
    expect((await scrape()).status).toBe(401);
    expect((await scrape({ authorization: "Bearer scrape-token-124" })).status).toBe(401);
    expect((await scrape({ ...bearer, "x-forwarded-for": "203.0.113.9" })).status).toBe(404);
  });

  it("lists the tasks, the queue, the runners, the database and the requests served", async () => {
    process.env["BRAIN_METRICS_TOKEN"] = "scrape-token-123";
    await harness.admin.query("overview", {});
    const response = await scrape(bearer);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    for (const name of ["brain_build_info", "brain_uptime_seconds", "brain_workspaces", "brain_goals_today", "brain_approvals_pending", "brain_oldest_queued_seconds", "brain_schedules_overdue", "brain_runners", "brain_runner_free_slots", "brain_sqlite_bytes", "brain_audit_events", "brain_event_loop_lag_seconds", "brain_process_resident_memory_bytes"]) {
      expect(text).toContain(`# TYPE ${name} gauge`);
    }
    expect(text).toMatch(/brain_http_request_duration_seconds_count\{route="v1\/query",status="2xx"\} [1-9]/u);
    expect(text).not.toContain("scrape-token-123");
  });
});
