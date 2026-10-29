import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "@brain/contracts/validate";
import { createApp } from "../../apps/governor/src/http/app";
import { seedHuman, setupWorld } from "../helpers";

// T02: every registered route is declared in the OpenAPI surface and every
// declared non-parameterized GET round-trips with a JSON body (200 or an
// explicit Brain error envelope, never an unhandled 404/500).
const ROOT = join(import.meta.dirname, "../..");

function routesFrom(source: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\("(\/[^"]*)"/g)) {
    out.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  }
  return out;
}

describe("endpoint surface conformance (T02)", () => {
  it("every registered route is declared in OpenAPI and declared GETs respond", async () => {
    const appSource = readFileSync(join(ROOT, "apps/governor/src/http/app.ts"), "utf8");
    const openapi = JSON.parse(readFileSync(join(ROOT, "contracts/v1/openapi.json"), "utf8")) as { paths: Record<string, unknown> };
    const extensions = JSON.parse(readFileSync(join(ROOT, "docs/api-extensions.json"), "utf8")) as { routes: Array<{ path: string }> };
    const declaredPaths = new Set([...Object.keys(openapi.paths), ...extensions.routes.map((r) => r.path)]);
    const routes = routesFrom(appSource).filter((r) => !r.path.startsWith("/api/auth") && r.path !== "/*" && !r.path.includes("*"));
    expect(routes.length).toBeGreaterThan(20);
    const undeclared = routes.filter((r) => !declaredPaths.has(r.path.replace(/:([A-Za-z]+)/g, "{$1}")));
    expect(undeclared).toEqual([]);

    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-responses-")), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const { token } = seedHuman(app.brain, w.org, "owner-1");
      const headers = { authorization: `Bearer ${token}` };
      const getPaths = [...new Set(routes.filter((r) => r.method === "GET").map((r) => r.path))];
      const fill = (p: string) => p
        .replace(":workspaceId", w.workspaceId)
        .replace(":id", "does-not-exist")
        .replace(":runId", "does-not-exist")
        .replace(":jobId", "does-not-exist")
        .replace(":digest", `sha256:${"0".repeat(64)}`)
        .replace(/:[A-Za-z]+/g, "does-not-exist");
      for (const path of getPaths) {
        const res = await app.fetch(new Request(`http://127.0.0.1:3000${fill(path)}`, { headers }));
        const body = await res.text();
        expect(res.status, `${path}: ${body.slice(0, 160)}`).not.toBe(500);
        if (res.headers.get("content-type")?.includes("application/json")) {
          const json = JSON.parse(body) as Record<string, unknown>;
          if (res.status >= 400) {
            // Errors always validate as the contract BrainError.
            const v = validate("BrainError", json);
            expect(v.ok, `${path}: ${v.ok ? "" : v.errors.join("; ")}`).toBe(true);
          }
        }
      }
    } finally {
      await app.close?.();
      app.brain.close();
    }
  }, 120_000);

  it("per-operation 200 bodies validate against their declared response schemas", async () => {
    const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-responses-schema-")), allowTestActor: true });
    try {
      const w = setupWorld(app.brain);
      const { token } = seedHuman(app.brain, w.org, "owner-1");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const status = await app.fetch(new Request("http://127.0.0.1:3000/v1/setup/status"));
      expect(status.status).toBe(200);
      const statusV = validate("SetupStatus", await status.json());
      expect(statusV.ok, statusV.ok ? "" : statusV.errors.join("; ")).toBe(true);

      const identity = await app.fetch(new Request("http://127.0.0.1:3000/v1/identity", { headers }));
      expect(identity.status).toBe(200);
      const identityV = validate("IdentityView", await identity.json());
      expect(identityV.ok, identityV.ok ? "" : identityV.errors.join("; ")).toBe(true);

      // Seed one row per pack table so list/get mapping is validated with
      // real data, not only the empty-list shape.
      const DIGEST = `sha256:${"b".repeat(64)}`;
      const ws = app.brain.store.workspaceDb(w.workspaceId, w.org);
      ws.prepare("INSERT INTO tickets(id, connector_id, remote_id, state, title, body_digest, source_version, observed_at_ms, created_at_ms) VALUES ('tkt-1','gitlab','7','open','Seed ticket',?,'v3',?,?)").run(DIGEST, Date.now(), Date.now());
      ws.prepare("INSERT INTO incidents(id, target_key, severity, title, state, version, opened_at_ms) VALUES ('inc-1','api','warning','API latency','investigating',2,?)").run(Date.now());
      ws.prepare("INSERT INTO observations(id, connector_id, target_key, incident_id, observation_digest, source_event_id, observed_at_ms, expires_at_ms) VALUES ('obs-1','probe','api','inc-1',?,'evt-1',?,?)").run(DIGEST, Date.now(), Date.now() + 3600_000);
      ws.prepare("INSERT INTO delivery_dossiers(id, source_revision, manifest_digest, rubric_digest, state, version, created_at_ms) VALUES ('dos-1',?,?,?,'evaluating',1,?)").run("sha256:" + "c".repeat(64), DIGEST, DIGEST, Date.now());
      ws.prepare("INSERT INTO rubric_results(dossier_id, criterion_id, evaluator_attempt_id, outcome, evidence_digest) VALUES ('dos-1','crit-1','att-1','passed',?)").run(DIGEST);
      ws.prepare("INSERT INTO cards(id, title, state, criteria_json, created_at_ms) VALUES ('card-seed','Seed card','todo','[\"c1\"]',?)").run(Date.now());
      ws.prepare("INSERT INTO decisions(id, card_id, actor_id, decision, note, created_at_ms) VALUES ('dec-1','card-seed','owner-1','go','seed decision',?)").run(Date.now());
      ws.prepare("INSERT INTO sla_intervals(id, ticket_id, event_id, responsibility, started_at_ms, ended_at_ms, calendar_digest) VALUES ('sla-1','tkt-1','evt-sla-1','keyrus',?,?,?)").run(Date.now() - 60000, Date.now(), DIGEST);

      const ask = async (payload: Record<string, unknown>) => {
        const res = await app.fetch(new Request("http://127.0.0.1:3000/v1/query", { method: "POST", headers, body: JSON.stringify(payload) }));
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const cases: Array<Record<string, unknown>> = [
        ...["today", "jobs.list", "approvals.list", "board.get", "tools.list",
          "decisions.list", "tickets.list", "incidents.list", "delivery.list", "sessions.list",
          "members.list", "audit.list", "runners.list", "platform.health", "workspace.context",
        ].map((queryType) => ({ queryType, workspaceId: w.workspaceId })),
        { queryType: "sla.summary", workspaceId: w.workspaceId, periodStart: new Date(Date.now() - 3600_000).toISOString(), periodEnd: new Date(Date.now() + 60000).toISOString() },
        { queryType: "config.explain", workspaceId: w.workspaceId, pointer: "/workflows/fixture-workflow" },
        { queryType: "search.global", workspaceId: w.workspaceId, search: "fixture", limit: 10 },
        { queryType: "ticket.get", workspaceId: w.workspaceId, resourceId: "tkt-1" },
        { queryType: "incident.get", workspaceId: w.workspaceId, resourceId: "inc-1" },
        { queryType: "delivery.get", workspaceId: w.workspaceId, resourceId: "dos-1" },
      ];
      const failures: string[] = [];
      for (const payload of cases) {
        const { status, body } = await ask(payload);
        const label = String(payload["queryType"]);
        if (status !== 200) { failures.push(`${label}: HTTP ${status} ${JSON.stringify(body).slice(0, 160)}`); continue; }
        const v = validate("QueryResponse", body);
        if (!v.ok) failures.push(`${label}: ${v.errors.slice(0, 3).join("; ")} :: ${JSON.stringify((body as { snapshot?: unknown }).snapshot).slice(0, 260)}`);
      }
      expect(failures).toEqual([]);
    } finally {
      await app.close?.();
      app.brain.close();
    }
  }, 120_000);
});
