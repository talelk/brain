import { scopeMethods, systemActor } from "./actor-context";
import { resolveModelKey, sha256Digest } from "@brain/contracts";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { putBytes, recordWorkspaceArtifact } from "../modules/artifacts/index";
import { claimJudgement, criterionMaterial, finishJudgement, judgeWorkList, judgedCriteria, latestBundleRow, recordBundleCheck, type Judgement } from "../modules/evidence/index";
import { eligibleRoutes, markRouteQuota, modelRoutesUsable, recordRouteUses, type ModelRoute } from "../modules/jobs/index";
import { judgeAdmitted, recordJudgeSpend, taskResult } from "../modules/missions/index";
import { JUDGE_PROMPT_VERSION, JudgeUnavailable, judgeCostMicroUsd, runJudge } from "../modules/packs/index";

interface Ports {
  readonly store: Store;
  /** The network port for model calls: tests and the browser fixture hand in a fake; the product uses the platform's fetch. */
  readonly modelFetch: () => typeof fetch;
}

type Db = ReturnType<Store["workspaceDb"]>;
type Coverage = { criterionId: string; text: string; workItems: Array<{ workItemId: string }>; checks: Array<{ name: string; outcome: string }> };

/**
 * The advisory judge (#95, ADR 0023). When a mission's evidence bundle is submitted and the workspace has a hosted model, the judge gives a
 * model opinion per success criterion from what the mission's work left: each opinion is an advisory check with its transcript as evidence.
 * It never records a verdict or changes the bundle, never blocks sign-off, and writes nothing without a model reply. Its calls are spend on the
 * mission and under the mission's and the workspace's caps. The request is a row (one per bundle), so a restart resumes it and two passes
 * never judge the same bundle twice.
 */
export class BundleJudge {
  private running: Promise<void> | undefined;
  private again = false;
  private readonly inFlight = new Set<string>();
  constructor(private readonly ports: Ports) {
    scopeMethods(this, { sweep: systemActor("bundle-judge") });
  }

  /** One pass over every active workspace; a pass asked for while one runs is run again right after it, so no submission is missed. */
  sweep(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          for (const ws of this.ports.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>) {
            try { await this.pass(ws.organization_id, ws.id); } catch { /* the next pass retries */ }
          }
        } while (this.again);
      } finally { this.running = undefined; }
    })();
    return this.running;
  }

  private async pass(organizationId: string, workspaceId: string): Promise<void> {
    const { store } = this.ports;
    const db = store.workspaceDb(workspaceId, organizationId);
    const usable = modelRoutesUsable(store, workspaceId);
    for (const request of judgeWorkList(store, db, this.inFlight, usable)) {
      if (!usable) { finishJudgement(store, db, request.bundleDigest, request.missionId, { state: "not-run", reason: "hosted-off" }); continue; }
      // Every route is down or out of quota (ADR 0023, ADR 0055): the judge waits for one, leaving requests pending; the verdict never waits.
      const routes = eligibleRoutes(store, workspaceId, "judge").routes;
      if (routes.length === 0) continue;
      if (!claimJudgement(store, db, request.bundleDigest, request.missionId, routes[0]!.model)) continue;
      this.inFlight.add(request.bundleDigest);
      try { await this.judge(workspaceId, db, request); } finally { this.inFlight.delete(request.bundleDigest); }
    }
  }

  private async judge(workspaceId: string, db: Db, request: Judgement): Promise<void> {
    const { store } = this.ports;
    const { bundleDigest, missionId } = request;
    const finish = (end: Parameters<typeof finishJudgement>[4]) => finishJudgement(store, db, bundleDigest, missionId, end);
    const bundle = latestBundleRow(db, missionId);
    if (bundle?.digest !== bundleDigest) { finish({ state: "not-run", reason: "too-late" }); return; }
    const coverage = (JSON.parse(bundle.manifest_json) as { coverage: Coverage[] }).coverage;
    const readable = coverage.flatMap((entry) => {
      const text = criterionMaterial(db, { criterionId: entry.criterionId, workItemIds: entry.workItems.map((item) => item.workItemId), checks: entry.checks }, (workItemId) => taskResult(db, workItemId)?.text);
      return text ? [{ entry, text }] : [];
    });
    if (readable.length === 0) { finish({ state: "not-run", reason: "no-evidence" }); return; }
    const have = judgedCriteria(db, bundleDigest);
    let judged = have.size;
    for (const { entry, text } of readable) {
      if (have.has(entry.criterionId)) continue;
      if (!judgeAdmitted(store, db, missionId)) { finish(judged > 0 ? { state: "done", reason: "budget" } : { state: "not-run", reason: "budget" }); return; }
      // The routes in order, each criterion starting again from the first one that is not out of quota: a 429 moves on to the next route, never a blind retry on the same one.
      let verdict: Awaited<ReturnType<typeof runJudge>> | undefined;
      let served: ModelRoute | undefined;
      let failure: JudgeUnavailable | undefined;
      const tried: Array<{ routeId: string; model: string; outcome: "served" | "quota" | "failed" }> = [];
      for (const route of eligibleRoutes(store, workspaceId, "judge").routes) {
        try {
          verdict = await runJudge({ criterionText: entry.text, evidenceText: text }, { baseUrl: route.baseUrl, model: route.model, ...(resolveModelKey(route.keyRef) ? { apiKey: resolveModelKey(route.keyRef)! } : {}), fetchImpl: this.ports.modelFetch() });
          served = route; tried.push({ routeId: route.routeId, model: route.model, outcome: "served" });
          break;
        } catch (error) {
          if (!(error instanceof JudgeUnavailable)) { failure = new JudgeUnavailable("the hosted model could not be asked"); break; }
          failure = error;
          if (!error.quota) { tried.push({ routeId: route.routeId, model: route.model, outcome: "failed" }); break; }
          tried.push({ routeId: route.routeId, model: route.model, outcome: "quota" });
          markRouteQuota(store, workspaceId, route.routeId, error.retryAfterMs, "the provider refused for quota or rate");
        }
      }
      if (!verdict || !served) {
        recordRouteUses(store, `judge:${bundleDigest}:${entry.criterionId}`, workspaceId, tried);
        finish({ state: "unavailable", reason: "model-unavailable", detail: failure?.message ?? "no model route could be asked", failed: true });
        return;
      }
      recordRouteUses(store, `judge:${bundleDigest}:${entry.criterionId}`, workspaceId, tried);
      const evaluator = `judge:${served.model}`;
      // Nothing below waits: the bundle is checked and the opinion written in one step, so a verdict recorded meanwhile leaves no late opinion on it.
      const tokens = verdict.usage ?? { inputTokens: Math.ceil((text.length + entry.text.length + 400) / 4), outputTokens: Math.ceil(verdict.raw.length / 4) };
      recordJudgeSpend(store, db, { missionId, attemptId: `judge:${bundleDigest}:${entry.criterionId}`, runId: `judge:${bundleDigest}`, model: served.model, microUsd: judgeCostMicroUsd(served, tokens), ...tokens, estimated: verdict.usage === undefined });
      const transcript = Buffer.from(JSON.stringify({
        promptVersion: JUDGE_PROMPT_VERSION, model: served.model, routeId: served.routeId, criterionId: entry.criterionId, criterionText: entry.text, evidence: text,
        outcome: verdict.outcome, rationale: verdict.rationale, raw: verdict.raw.slice(0, 4096),
      }), "utf8");
      const digest = putBytes(store, transcript);
      try {
        store.inTx(db, () => {
          recordWorkspaceArtifact(db, { artifactId: `art-judge-${sha256Digest(transcript).slice(7, 31)}`, digest, bytes: transcript.length, mediaType: "application/json", classification: "workspace" }, store.now());
          recordBundleCheck(store, db, { missionId, bundleDigest, criterionId: entry.criterionId, evaluator, outcome: verdict.outcome, evidenceDigest: digest, advisory: true });
        });
      } catch (error) {
        if (!(error instanceof BrainDomainError)) throw error;
        finish({ state: "not-run", reason: "too-late" });
        return;
      }
      judged += 1;
    }
    finish({ state: "done" });
  }
}
