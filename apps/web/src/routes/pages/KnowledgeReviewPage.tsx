import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { CapitalizationStudio, type CapitalizationSnapshot } from "../../ui/studio/CapitalizationStudio";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { BrainPage } from "../../ui/components/PageLayout";
import { KnowledgeTabs } from "../../ui/components/KnowledgeTabs";

/**
 * `/w/:id/knowledge/review` (#43): the knowledge candidate review queue —
 * capitalization runs, the assets they produced and capability candidates a
 * reviewer approves or rejects before a separate, governed publication.
 */
export default function KnowledgeReviewPage(): JSX.Element {
  const app = useApp();
  const capitalization = createScopedRead<CapitalizationSnapshot>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [assets, candidates, runs] = await Promise.all([
        query<{ snapshot: { items: CapitalizationSnapshot["assets"] }; asOf: string; sourceWatermark: number }>({ queryType: "knowledgeAssets.list", workspaceId: scope.workspaceId }, signal),
        query<{ snapshot: { items: CapitalizationSnapshot["candidates"] }; asOf: string; sourceWatermark: number }>({ queryType: "capabilityCandidates.list", workspaceId: scope.workspaceId }, signal),
        query<{ snapshot: { items: CapitalizationSnapshot["runs"] }; asOf: string; sourceWatermark: number }>({ queryType: "capitalizationRuns.list", workspaceId: scope.workspaceId }, signal),
      ]);
      return { asOf: runs.asOf, sourceWatermark: runs.sourceWatermark, snapshot: { assets: [...assets.snapshot.items], candidates: [...candidates.snapshot.items], runs: [...runs.snapshot.items] } };
    },
    isEmpty: (snapshot) => snapshot.assets.length === 0 && snapshot.candidates.length === 0 && snapshot.runs.length === 0,
    refreshMs: 3000,
  });
  const [message, setMessage] = createSignal("");
  const emptyCapitalization = { assets: [], candidates: [], runs: [] } satisfies CapitalizationSnapshot;
  return <div class="flex min-w-0 flex-col gap-3">
    <ActionFeedback message={message()} />
    <KnowledgeTabs value="review" />
    <BrainPage title="Review inbox" description="Approve the knowledge Brain wrote up from finished missions so search and future plans can use it, and review tool candidates it noticed.">
      <CapitalizationStudio snapshot={capitalization.state().data ?? emptyCapitalization} canRun={app.canPublish()} canReview={app.identity()?.actor.scopes.includes("tool:publish") ?? false}
          canReviewKnowledge={app.canAdminister()} canRevokeKnowledge={app.identity()?.actor.scopes.includes("memory:admin") ?? false}
          onReviewKnowledge={async (asset, decision, reason) => { try { const result = await app.run("knowledge.review", { assetId: asset.assetId, decision, reason }); setMessage(decision === "approve" ? "Published. It is now searchable and offered to future plans." : result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "The review was not saved."); } }}
          onRevokeKnowledge={async (asset, reason) => { try { const result = await app.run("memory.revoke", { sourceId: asset.assetId, reason }); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Withdrawing was not saved."); } }}
          onRun={async () => { try { const result = await app.run("capitalization.run", {}); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Capitalization failed."); } }}
          onReview={async (candidate, decision) => { try { const result = await app.run("capability.review", { candidateId: candidate.candidateId, decision, reason: decision === "approve" ? "Verified provenance and tests reviewed" : "Candidate rejected after review" }); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed."); } }}
          onPublish={async (candidate) => { try { const result = await app.run("tool.publish", { release: candidate.release, evidence: [...candidate.evidenceDigests] }); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Publication failed."); } }} />
    </BrainPage>
  </div>;
}
