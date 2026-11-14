import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock, KnowledgeAsset } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { TaskExperience } from "../../apps/governor/src/modules/workflows/index";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { achievedMission, command } from "../support/reuse";
import { fixtureStarter } from "../support/starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

// Spec #90, story 10 and 11: what earlier missions proved reaches the agents of later ones, as a claim with provenance and never as evidence.
const CHURN = { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"] };
const LATER = { title: "Churn report for the board", intent: "Write the quarterly churn report for the board with the biggest causes", successCriteria: ["The report names the causes"] };

interface Hit { sourceId: string; text: string; status: string; provenance: string[]; sourceType?: string; title?: string; claim?: boolean }

async function loop() {
  const root = mkdtempSync(join(tmp, "brain-knowledge-agents-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  const w = setupWorld(app.brain);
  const bundle = fixtureStarter();
  const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  w.brain.activateRelease(w.owner, release.digest);
  const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  let enrolled = 0;
  const enroll = async () => {
    enrolled += 1;
    const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: `runner-agents-${enrolled}`, stateDir: join(root, `agents-${enrolled}`), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
    return { cfg, session: await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token) };
  };
  let runner = await enroll();
  const tasks = new TaskExperience(w.brain.store, {
    query: (actor, query) => w.brain.executeQuery(actor, query),
    dispatch: async (actor, cmd) => ({ receipt: (await w.brain.executeCommand(actor, cmd, "knowledge-agents")).receipt }),
    knowledgeHits: (actor, workspaceId, query, limit) => w.brain.knowledgeHits(actor, workspaceId, query, limit),
  });
  let calls = 0;
  /** A later session of an agent: the real runner proposes knowledge.search, the Governor brokers it, the pinned script shapes the result. */
  async function agentSearch(query: string): Promise<{ result: string; hits: Hit[]; note: string }> {
    calls += 1;
    const runId = (await command(w, w.owner, "workflow.dispatch", `agent-search-${calls}`, { workflow: { id: "general-task", digest: release.digest }, input: { situation: `Look something up\nAcceptance criteria:\n1. Uses the tool\nFIXTURE_CALL_TOOL ${JSON.stringify({ id: "knowledge.search", input: { query } })}` } })).resourceId;
    const events = (): Array<{ kind?: string; payload: { receipt: { result: string; stdout: { digest: string } } } }> => (w.brain.store.control.prepare(
      "SELECT e.event_json FROM attempt_events e JOIN job_attempts a ON a.id=e.attempt_id JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=? ORDER BY e.seq").all(runId) as Array<{ event_json: string }>)
      .map((row) => (JSON.parse(row.event_json) as { payload: { kind?: string; payload: { receipt: { result: string; stdout: { digest: string } } } } }).payload).filter((entry) => entry.kind === "tool.result");
    // The queue is shared with the planner's own jobs, so run claims until this search's session has finished.
    for (let turn = 0; turn < 6 && events().length === 0; turn++) await runOnce(runner.cfg, runner.session.sessionToken, runner.session.epoch);
    const results = events();
    const receipt = results[0]!.payload.receipt;
    const output = JSON.parse(new TextDecoder().decode(readVerified(w.brain.store, receipt.stdout.digest))) as { results?: Hit[]; note?: string };
    return { result: receipt.result, hits: output.results ?? [], note: output.note ?? "" };
  }
  async function plannerRelated(requestId: string): Promise<string> {
    const started = await tasks.startMissionPlan(w.owner, { workspaceId: w.workspaceId, requestId, ...LATER });
    const job = w.brain.store.control.prepare("SELECT p.payload_json FROM jobs j JOIN job_payloads p ON p.job_id=j.id WHERE j.workflow_run_id=? AND j.step_id='propose'").get(started.runId) as { payload_json: string };
    return (JSON.parse(job.payload_json) as { input: { related: string } }).input.related;
  }
  const assets = async (): Promise<KnowledgeAsset[]> => ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
  return { w, app, agentSearch, reenroll: async () => { runner = await enroll(); }, plannerRelated, assets, close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });
async function world() { const l = await loop(); open.push(l.close); return l; }

describe("published knowledge reaches agents and the planner (#96)", () => {
  it("a mission closes achieved, capitalization publishes its write-up, and a later session and a later plan are handed it as a labelled claim with provenance", async () => {
    const l = await world();
    const missionId = await achievedMission(l.w, "src", { ...CHURN, autoPublish: true, outputs: [{ name: "churn-report.md", text: "Pricing confusion drove most cancellations." }] });
    const [asset] = await l.assets();
    expect(asset).toMatchObject({ state: "published", missionId });

    const found = await l.agentSearch("quarterly churn report causes");
    expect(found.result).toBe("succeeded");
    expect(found.hits.map((hit) => hit.sourceId)).toEqual([asset!.assetId]);
    const hit = found.hits[0]!;
    expect(hit).toMatchObject({ status: "reviewed", sourceType: "knowledge", title: CHURN.title, claim: true });
    expect(hit.provenance).toEqual(expect.arrayContaining([asset!.assetId, `mission:${missionId}`]));
    expect(hit.text).toContain("churn");
    expect(found.note).toContain("claims");
    expect(found.note).toContain("never evidence");

    const related = await l.plannerRelated("plan-later");
    expect(related).toContain("Stored knowledge matching this objective");
    expect(related).toContain("not evidence");
    expect(related).toContain(`[reviewed]`);
    expect(related).toContain(asset!.assetId);
    expect(related).toContain(`mission ${missionId}`);
  });

  it("revoked knowledge is never returned to a session or the planner", async () => {
    const l = await world();
    await achievedMission(l.w, "rev", { ...CHURN, autoPublish: true });
    const [asset] = await l.assets();
    expect((await l.agentSearch("quarterly churn report causes")).hits).toHaveLength(1);
    await command(l.w, l.w.owner, "memory.revoke", "rev-1", { sourceId: asset!.assetId, reason: "wrong" });
    expect((await l.agentSearch("quarterly churn report causes")).hits).toEqual([]);
    expect(await l.plannerRelated("plan-revoked")).not.toContain(asset!.assetId);
  });

  it("expired knowledge is never returned, even before the sweep has withdrawn it", async () => {
    const l = await world();
    await achievedMission(l.w, "exp", { ...CHURN, autoPublish: true });
    const [asset] = await l.assets();
    expect(asset!.state).toBe("published");
    // No one has used it for a whole period; the sweep has not run yet.
    const skew = 91 * 86_400_000;
    (l.w.brain.store as unknown as { clock: Clock }).clock = { nowMs: () => Date.now() + skew, monotonicMs: () => performance.now() };
    await l.reenroll();
    expect((await l.agentSearch("quarterly churn report causes")).hits).toEqual([]);
    expect(await l.plannerRelated("plan-expired")).not.toContain(asset!.assetId);
    expect((await l.assets())[0]!.state).toBe("published");
    l.w.brain.runCapitalization();
    expect((await l.assets())[0]!.state).toBe("revoked");
    expect((await l.agentSearch("quarterly churn report causes")).hits).toEqual([]);
  });

  it("another workspace's knowledge is never returned", async () => {
    const l = await world();
    l.w.brain.memory.publish({ organizationId: l.w.org, workspaceId: "ws-elsewhere", sourceId: "kb-secret", text: "Quarterly churn report causes, which this mission must not see.", sourceType: "knowledge", status: "reviewed" });
    expect((await l.agentSearch("quarterly churn report causes")).hits).toEqual([]);
  });

  it("reusing knowledge is a claim: a mission whose only successful call was a knowledge search is not written up as observed", async () => {
    const l = await world();
    await achievedMission(l.w, "lean", { title: "Reused churn answer", intent: "Answer the churn question from stored knowledge", criteria: ["answered"], autoPublish: true, observedTool: "knowledge.search" });
    expect(await l.assets()).toEqual([]);
    await achievedMission(l.w, "real", { title: "Observed churn answer", intent: "Answer the churn question from the data warehouse", criteria: ["answered"], autoPublish: true, observedTool: "documents.read" });
    expect(await l.assets()).toHaveLength(1);
  });
});
