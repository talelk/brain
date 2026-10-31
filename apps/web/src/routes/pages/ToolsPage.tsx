import { query } from "../../data/client";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ToolCandidateView, ToolCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { toolsQuery } from "../../data/governor";
import { ToolsScreen, type ToolProposalInput } from "../knowledge";
import { ActionFeedback } from "../../ui/components/ActionFeedback";

export default function ToolsPage(): JSX.Element {
  const app = useApp();
  const tools = createScopedRead<ToolCatalogEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await toolsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 60_000,
  });
  const candidates=createScopedRead<ToolCandidateView[]>({scope:app.scope,load:async(scope,signal)=>{
    const loaded=await query<{snapshot:{items:ToolCandidateView[]};asOf:string;sourceWatermark:number}>({queryType:"toolCandidates.list",workspaceId:scope.workspaceId},signal);
    return {...loaded,snapshot:loaded.snapshot.items};
  }});
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <ActionFeedback message={message()} />
    <ToolsScreen candidates={candidates.state().data??[]} tools={tools.state().data ?? []} state={tools.state()}
      onRefresh={() => void tools.refresh({ force: true })} canPublish={app.canPublish()}
      onPropose={async (proposal: ToolProposalInput) => {
        try {
          const result = await app.run("tool.propose", proposal);
          setMessage(result.detail);
          await Promise.all([tools.refresh({ force: true }),candidates.refresh({force:true})]);
        } catch (e) { setMessage(e instanceof Error ? e.message : "Proposal failed."); }
      }}
      onPublish={async (release, evidence) => {
        try {
          const result = await app.run("tool.publish", { release, evidence });
          setMessage(result.detail);
          await Promise.all([tools.refresh({ force: true }),candidates.refresh({force:true})]);
        } catch (e) { setMessage(e instanceof Error ? e.message : "Publish failed."); }
      }} />
  </div>;
}
