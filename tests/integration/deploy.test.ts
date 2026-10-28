import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { Store } from "../../apps/governor/src/application/store";

// T48 packet acceptance (local slice): readiness is real store state, a
// second process cannot open the same data dir, and graceful close leaves a
// reopenable store. Image/compose serving is proven in
// tests/probes/deployment.
describe("deployment readiness and lifecycle (T48)", () => {
  it("health reflects the live store; the data dir is single-writer locked", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-deploy-"));
    const brain = new Brain({ dataDir: dir });
    const health = brain.health();
    expect(health.ready).toBe(true);
    expect(health.detail).toMatch(/control\.db/);
    expect(() => new Store({ dataDir: dir })).toThrow(/lock|in use|already/i);
    brain.close();
    // Graceful close releases the lock and the store reopens on the same data.
    const reopened = new Brain({ dataDir: dir });
    expect(reopened.health().ready).toBe(true);
    reopened.close();
  });

  it("compose and image definitions agree on port, volume and healthcheck", () => {
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(compose).toContain("brain-governor:t48");
    expect(compose).toContain("127.0.0.1:3100:3100");
    expect(compose).toContain("brain-data:/data");
    expect(dockerfile).toContain("EXPOSE 3100");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("USER node");
  });
});
