import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import type { MemoryResult, ToolCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { memorySearchQuery, toolsQuery } from "../../data/governor";
import { KnowledgeScreen, type MemoryPublicationInput } from "../knowledge";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { KnowledgeTabs, type KnowledgeTab } from "../../ui/components/KnowledgeTabs";
import ResourcesPage from "./ResourcesPage";
import ToolsPage from "./ToolsPage";

/**
 * `/w/:id/knowledge` (#43): the secondary Knowledge place — scoped knowledge
 * with provenance (find and publish), workspace documents and the trusted tool
 * registry, as tabs of one page. The review queue has its own route.
 */
export default function KnowledgePage(): JSX.Element {
  const app = useApp();
  const [searchText, setSearchText] = createSignal("");
  const [params] = useSearchParams();
  const journey = (): KnowledgeTab => (params.tab === "documents" || params.tab === "tools" ? params.tab : "find");
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
  const [message, setMessage] = createSignal("");
  return <div class="flex min-w-0 flex-col gap-3">
    <ActionFeedback message={message()} />
    <KnowledgeTabs value={journey()} trailing={<>
      <Show when={journey() === "find" && app.identity()?.integrations.memoryUiUrl}>
        <a class="inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 text-caption font-medium text-ink-blue-link hover:bg-surface-gray-2 focus-visible:focus-ring" href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer">
          <span class="lucide-external-link size-3.5" aria-hidden="true" />Open Memory UI
        </a>
      </Show>
    </>} />
    <Show when={journey() === "documents"}><ResourcesPage /></Show>
    <Show when={journey() === "tools"}><ToolsPage /></Show>
    <Show when={journey() === "find"}>
      <KnowledgeScreen workspaceId={app.workspaceId()} tools={knowledge.state().data?.tools ?? []}
        state={knowledge.state()} searched={searchText().trim().length > 0} onRefresh={() => void knowledge.refresh({ force: true })}
        onSearch={(text) => { setSearchText(text); void knowledge.refresh({ force: true }); }}
        onPublish={async (publication: MemoryPublicationInput) => {
          try { const result = await app.run("memory.publish", publication); setMessage(result.detail); await knowledge.refresh({ force: true }); }
          catch (e) { setMessage(e instanceof Error ? e.message : "Publication failed."); }
        }}
        onRevoke={async (sourceId, reason) => {
          try { const result = await app.run("memory.revoke", { sourceId, reason }); setMessage(result.detail); await knowledge.refresh({ force: true }); }
          catch (e) { setMessage(e instanceof Error ? e.message : "Revocation failed."); }
        }}
        canPublish={app.canPublish()} />
    </Show>
  </div>;
}
