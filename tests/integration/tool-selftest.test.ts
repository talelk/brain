import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("a tool's own test.sh runs from the product (self-test)", () => {
  it("stages the test script with the release, runs it beside the tool's pinned script and shows its result, for read and effect tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-selftest-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const bundle = fixtureStarter();
    // Every tool of the starter release stages its test script under the reserved id.
    expect(bundle.scripts.map((script) => script.toolId)).toEqual(expect.arrayContaining(["selftest.host.restart", "selftest.git.open-pr", "selftest.host.exec"]));
    const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
    w.brain.activateRelease(w.owner, release.digest);
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "selftest-agents", stateDir: mkdtempSync(join(tmpdir(), "runner-selftest-")), engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], transport };
    cleanup.push(() => rmSync(cfg.stateDir, { recursive: true, force: true }));
    const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);

    // An effect tool cannot be tried with an input (it changes things), but its self-test changes nothing and may run.
    expect(() => w.brain.toolTests.run(w.owner, w.workspaceId, "host.restart", { container: "x" })).toThrow(/self-test/);
    for (const toolId of ["host.restart", "ticket.create", "host.exec"]) {
      const { testId } = w.brain.toolTests.selfTest(w.owner, w.workspaceId, toolId);
      expect(await runOnce(cfg, session.sessionToken, session.epoch)).toBe(true);
      const view = w.brain.toolTests.list(w.owner, w.workspaceId, toolId, 10).find((entry) => entry.testId === testId)!;
      expect(view, toolId).toMatchObject({ kind: "selftest", state: "succeeded", output: { passed: true, exitCode: 0 } });
      expect((view.output as { output: string }).output).toContain(`${toolId}: ok`);
    }
    // The self-test never counts as a call of the tool, and an unknown tool or one without a test script is refused plainly.
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
    expect(() => w.brain.toolTests.selfTest(w.owner, w.workspaceId, "no.such.tool")).toThrow(/not in this release/);
  }, 120_000);
});
