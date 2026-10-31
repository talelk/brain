import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { MemoryResult, ToolCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { memorySearchQuery, toolsQuery } from "../../data/governor";
import { KnowledgeScreen, type MemoryPublicationInput } from "../knowledge";
import { CapitalizationStudio, type CapitalizationSnapshot } from "../../ui/studio/CapitalizationStudio";
import { ActionFeedback } from "../../ui/components/ActionFeedback";

export default function KnowledgePage(): JSX.Element {
  const app = useApp();
  const [searchText, setSearchText] = createSignal("");
  const knowledge = createScopedRead<{ results: MemoryResult[]; degraded: boolean; tools: ToolCatalogEntry[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const identity = app.identity();
      type MemorySearch = { snapshot: { results: readonly MemoryResult[]; degraded: boolean } };
      const memory: MemorySearch = searchText().trim() && identity
        ? await memorySearchQuery(scope.workspaceId, {
          contractVersion: "brain.memory/v1", queryId: `web-${crypto.randomUUID()}`,
          scope: { organizationId: identity.actor.organizationId, visibility: "workspace", workspaceId: scope.workspaceId },
          query: searchText().trim(), sourceTypes: ["chat", "skill", "wiki", "codegraph"], limit: 10, maxChars: 4000,
        }, signal).catch(() => ({ snapshot: { results: [] as MemoryResult[], degraded: true } }))
        : { snapshot: { results: [], degraded: false } };
      const tools = await toolsQuery(scope.workspaceId, signal);
      return {
        asOf: tools.asOf, sourceWatermark: tools.sourceWatermark,
        snapshot: { results: [...memory.snapshot.results], degraded: memory.snapshot.degraded, tools: [...tools.snapshot.items] },
      };
    },
    isEmpty: (data) => data.results.length === 0,
  });
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
  return <div class="flex flex-col gap-field-gap">
    <ActionFeedback message={message()} />
    <Show when={app.identity()?.integrations.memoryUiUrl}><a href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer">Open Memory UI</a></Show>
    <CapitalizationStudio snapshot={capitalization.state().data ?? emptyCapitalization} canRun={app.canPublish()} canReview={app.identity()?.actor.scopes.includes("tool:publish") ?? false}
      onRun={async () => { try { const result = await app.run("capitalization.run", {}); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Capitalization failed."); } }}
      onReview={async (candidate, decision) => { try { const result = await app.run("capability.review", { candidateId: candidate.candidateId, decision, reason: decision === "approve" ? "Verified provenance and tests reviewed" : "Candidate rejected after review" }); setMessage(result.detail); await capitalization.refresh({ force: true }); } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed."); } }}
      onPublish={async (candidate) => { try { const result = await app.run("tool.publish", { release: candidate.release, evidence: [...candidate.evidenceDigests] }); setMessage(result.detail); await Promise.all([capitalization.refresh({ force: true }), knowledge.refresh({ force: true })]); } catch (error) { setMessage(error instanceof Error ? error.message : "Publication failed."); } }} />
    <KnowledgeScreen workspaceId={app.workspaceId()} tools={knowledge.state().data?.tools ?? []}
      state={knowledge.state()} searched={searchText().trim().length > 0} onRefresh={() => void knowledge.refresh({ force: true })}
      onSearch={(text) => { setSearchText(text); void knowledge.refresh({ force: true }); }}
      onPublish={async (publication: MemoryPublicationInput) => {
        try {
          const result = await app.run("memory.publish", publication);
          setMessage(result.detail);
          await knowledge.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Publication failed."); }
      }}
      onRevoke={async (sourceId, reason) => {
        try {
          const result = await app.run("memory.revoke", { sourceId, reason });
          setMessage(result.detail);
          await knowledge.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Revocation failed."); }
      }}
      canPublish={app.canPublish()} />
  </div>;
}
