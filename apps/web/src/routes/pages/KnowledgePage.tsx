import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { MemoryResult, ToolCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { memorySearchQuery, toolsQuery } from "../../data/governor";
import { KnowledgeScreen, type MemoryPublicationInput } from "../knowledge";

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
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <Show when={app.identity()?.integrations.memoryUiUrl}><a href={app.identity()!.integrations.memoryUiUrl!} target="_blank" rel="noopener noreferrer">Open Memory UI</a></Show>
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
