import { seedOrganization } from "../helpers";
import { attestDomain, bundleForAttempt } from "../support/evidence";
import { describe, expect, it } from "vitest";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { createApp } from "../../apps/governor/src/http/app";
import { createAdaptorServer } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function serveOnRandomPort(fetchFn: (r: Request) => Response | Promise<Response>): Promise<{ url: string; close: () => void }> {
  const server = createAdaptorServer({ fetch: fetchFn });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };
}

describe("golden workflow end-to-end (T29/T30, G03 smoke)", () => {
  it("dispatches echo, runs both fixture tools on separate runners, verifies output", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "brain-golden-"));
    const app = await createApp({ dataDir, allowTestActor: true });
    const brain = app.brain;
    const worldDir = dataDir;
    void worldDir;
    // Bootstrap a world inside this app's Brain.
    const boot = seedOrganization(brain, { organizationId: "org-golden", ownerId: "owner-golden" });
    void boot;
    const { scopesForPrincipal } = await import("../../apps/governor/src/application/authz");
    const mkActor = (id: string, ws?: string) => ({
      kind: "human" as const, actorId: id, organizationId: "org-golden",
      ...(ws ? { workspaceId: ws } : {}),
      scopes: scopesForPrincipal(brain.store, id, "org-golden", ws),
      authMethod: "session" as const, authGeneration: 1,
    });
    const owner = mkActor("owner-golden");
    brain.createWorkspace(owner, { workspaceId: "ws-golden", slug: "golden" });
    const ownerWs = mkActor("owner-golden", "ws-golden");
    const { goldenDocs } = await import("../helpers");
    const { digest } = brain.stageRelease(ownerWs, goldenDocs(), "sha256:130a2071b2874c9d9b427b38eb47a93b61b18f2a1186c4521d2ab16f4be67b3b");
    brain.activateRelease(ownerWs, digest);

    let close: (() => void) | undefined;
    try {
      const listener = await serveOnRandomPort(app.fetch);
      const url = listener.url;
      close = listener.close;
      const caps = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"];
      const toolToken = brain.issueEnrollment(ownerWs, "fixture-tools");
      const evalToken = brain.issueEnrollment(ownerWs, "fixture-evaluators");
      const toolCfg = { governorUrl: url, runnerId: "runner-tools-1", stateDir: mkdtempSync(join(tmpdir(), "runner-tools-")), capabilities: caps };
      const evalCfg = { governorUrl: url, runnerId: "runner-eval-1", stateDir: mkdtempSync(join(tmpdir(), "runner-eval-")), capabilities: caps };
      const toolSession = await enrollAndHello(toolCfg, toolToken.token);
      const evalSession = await enrollAndHello(evalCfg, evalToken.token);

      const { receipt } = brain.executeCommand(ownerWs, {
        contractVersion: "brain.command/v1", commandId: "cmd-dispatch-1", commandType: "workflow.dispatch",
        workspaceId: "ws-golden", idempotencyKey: "dispatch-1",
        payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
      }, "corr-1");
      expect(receipt.accepted).toBe(true);
      const runId = (receipt as { resourceId?: string }).resourceId ?? "";
      expect(runId).toBeTruthy();

      // The author remains verifying until the separately admitted evaluator
      // runs the actual pinned fixture tool and submits its normalized receipt.
      expect(await runOnce(toolCfg,toolSession.sessionToken)).toBe(true);
      const author = brain.store.control.prepare("SELECT a.id,j.state FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=? AND j.step_id='echo'").get(runId) as {id:string;state:string};
      expect(author.state).toBe("verifying");
      const bundle=bundleForAttempt(brain,"org-golden","ws-golden",author.id,"bundle-echo-1");
      brain.submitEvidence({runnerId:toolCfg.runnerId,epoch:toolSession.epoch,organizationId:"org-golden"},bundle);
      // Separate trust domains are Governor-verified fixture facts, never claims
      // granted by runner hello. Production attestation is a separate adapter.
      attestDomain(brain,toolCfg.runnerId,"author-host");
      attestDomain(brain,evalCfg.runnerId,"evaluator-host");
      expect(await runOnce(evalCfg,evalSession.sessionToken)).toBe(true);
      const jobs = brain.store.control.prepare("SELECT state FROM jobs WHERE workflow_run_id=?").all(runId) as Array<{state:string}>;
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j)=>j.state==="succeeded")).toBe(true);
      expect(brain.store.workspaceDb("ws-golden","org-golden").prepare("SELECT COUNT(*) AS n FROM verification_verdicts WHERE outcome='verified'").get()).toEqual({n:1});
      const runRow = brain.store.workspaceDb("ws-golden", "org-golden").prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string };
      expect(runRow.state).toBe("succeeded");
    } finally {
      close?.();
      await app.close();
    }
  }, 60_000);
});
