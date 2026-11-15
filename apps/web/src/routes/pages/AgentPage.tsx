import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { Badge } from "@talelk/newui-atoms";
import type { ActivityProfile, AgentCatalogEntry, Mission, UsageView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { GovernorError } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { AgentActivity } from "../../ui/components/AgentActivity";
import { LibraryTabs } from "../../ui/components/LibraryTabs";
import { formatUsd, titleize } from "../../ui/format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
interface View { profile: ActivityProfile; usage: UsageView; definition: AgentCatalogEntry | undefined; missions: ReadonlyMap<string, string> }

/** The purpose of an agent: the first paragraph of its pinned instructions that is not a heading. */
const purposeOf = (instructions: string): string => {
  const paragraphs = instructions.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  return paragraphs.find((part) => !part.startsWith("#")) ?? paragraphs[0]?.replace(/^#{1,6}\s+/u, "") ?? "";
};

/**
 * `/w/:id/library/agents/:agentId` (#113, ADR 0014/0029): one agent definition. What it is comes from the active release (`agents.get`); what it
 * is doing, its recent runs, verified rate and failure classes are worked out by the Governor from its records (`agents.profile`); cost is its
 * ledger share (`usage.agent`). Status is never stored, and every figure shows the words that define it.
 */
export default function AgentPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const read = createScopedRead<View>({
    scope: app.scope, resource: () => params.agentId, live: true,
    load: async (scope, signal) => {
      const id = params.agentId ?? "";
      const [profile, usage, missions, definition] = await Promise.all([
        query<Envelope<ActivityProfile>>({ queryType: "agents.profile", workspaceId: scope.workspaceId, resourceId: id }, signal),
        query<Envelope<UsageView>>({ queryType: "usage.agent", workspaceId: scope.workspaceId, resourceId: id }, signal),
        query<Envelope<{ items: Mission[] }>>({ queryType: "missions.list", workspaceId: scope.workspaceId }, signal),
        // An agent that the active release no longer defines still has a history: only its definition is missing.
        query<Envelope<AgentCatalogEntry>>({ queryType: "agents.get", workspaceId: scope.workspaceId, resourceId: id }, signal).catch((error: unknown) => {
          if (error instanceof GovernorError && error.status === 404) return undefined;
          throw error;
        }),
      ]);
      return { snapshot: { profile: profile.snapshot, usage: usage.snapshot, definition: definition?.snapshot, missions: new Map(missions.snapshot.items.map((mission) => [mission.missionId, mission.title] as const)) }, asOf: profile.asOf, sourceWatermark: profile.sourceWatermark };
    },
  });
  const title = () => titleize(params.agentId ?? "");
  return <div class="flex min-w-0 flex-col gap-3">
    <LibraryTabs value="agents" />
    <BrainPage title={title()}
      breadcrumbs={[{ label: t("agents.title"), href: `/w/${app.workspaceId()}/library/agents` }]}>
      <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("agents.empty.title")} emptyDescription={t("agents.empty.description")}>
        <Show when={read.state().data}>{(view) => <PageStack>
          <WorkspaceSection title={t("agent.section.definition")} description={view().definition ? t("agent.section.definition.note") : t("agent.notInRelease")}>
            <Show when={view().definition} fallback={<p class="m-0 text-interface text-ink-gray-7" data-testid="agent-not-in-release">{t("agent.notInRelease")}</p>}>{(definition) => <div class="flex min-w-0 flex-col gap-3" data-testid="agent-definition">
              <p class="m-0 min-w-0 break-words text-interface text-ink-gray-9" data-testid="agent-purpose">{purposeOf(definition().instructions) || t("agent.purpose.none")}</p>
              <div class="flex min-w-0 flex-col gap-1">
                <h3 class="m-0 text-caption font-medium text-ink-gray-7">{t("agent.tools")}</h3>
                <Show when={definition().definition.spec.tools.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("agent.tools.none")}</p>}>
                  <div class="flex flex-wrap gap-2" data-testid="agent-tools"><For each={definition().definition.spec.tools}>{(tool) => <Badge variant="outline" theme="gray" label={tool.id} />}</For></div>
                </Show>
              </div>
              <div class="flex min-w-0 flex-col gap-1">
                <h3 class="m-0 text-caption font-medium text-ink-gray-7">{t("agent.caps")}</h3>
                <p class="m-0 text-interface text-ink-gray-9" data-testid="agent-caps">{t("agent.caps.line", { turns: definition().definition.spec.maxTurns, tokens: definition().definition.spec.maxTokens.toLocaleString("en-GB"), cost: formatUsd(definition().definition.spec.maxMicroUsd), children: definition().definition.spec.maxChildren, depth: definition().definition.spec.maxDepth })}</p>
                <p class="m-0 text-caption text-ink-gray-7">{t("agent.engine", { engines: definition().definition.spec.engine.anyOf.join(" / ") })}</p>
              </div>
              <A class="text-caption text-ink-blue-link underline focus-visible:focus-ring" href={`/studio/Agent?selected=${encodeURIComponent(definition().release.id)}`}>{t("nav.item.studio")}</A>
            </div>}</Show>
          </WorkspaceSection>
          <AgentActivity profile={view().profile} usage={view().usage} costDefinition={t("agent.figure.cost.agent.definition")} workspaceId={app.workspaceId()} missions={view().missions} />
        </PageStack>}</Show>
      </ScreenRegion>
    </BrainPage>
  </div>;
}
