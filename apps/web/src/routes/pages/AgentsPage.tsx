import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ActivityProfile, AgentCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { ActivityBadge } from "../../ui/components/AgentActivity";
import { LibraryTabs } from "../../ui/components/LibraryTabs";
import { agentHref } from "../../ui/mission-links";
import { titleize } from "../../ui/format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
interface Row { agentId: string; summary: string; tools: number; profile: ActivityProfile | undefined }

/** First paragraph of the pinned instructions: what the agent is for, never inferred. */
const purposeOf = (instructions: string | undefined): string => {
  const paragraphs = (instructions ?? "").split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const first = paragraphs.find((part) => !part.startsWith("#")) ?? paragraphs[0]?.replace(/^#{1,6}\s+/u, "") ?? "";
  return first.length > 160 ? `${first.slice(0, 159).trimEnd()}…` : first;
};

/**
 * `/w/:id/library/agents` (#113, ADR 0014): every agent definition of the active release with what it is doing now. The status of each is
 * worked out by the Governor from its session records on every read (`agents.profile`), never stored; each row opens the agent's page.
 */
export default function AgentsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const rows = createScopedRead<Row[]>({
    scope: app.scope, live: true,
    load: async (scope, signal) => {
      const [definitions, profiles] = await Promise.all([
        query<Envelope<{ items: AgentCatalogEntry[] }>>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal),
        query<Envelope<{ items: ActivityProfile[] }>>({ queryType: "agents.profile", workspaceId: scope.workspaceId }, signal),
      ]);
      const byId = new Map(profiles.snapshot.items.map((profile) => [profile.id, profile] as const));
      const known = definitions.snapshot.items.map((entry): Row => ({ agentId: entry.release.id, summary: purposeOf(entry.instructions), tools: entry.definition.spec.tools.length, profile: byId.get(entry.release.id) }));
      // An agent seen at work that the active release no longer defines is still listed: its history exists.
      const extra = profiles.snapshot.items.filter((profile) => !known.some((row) => row.agentId === profile.id)).map((profile): Row => ({ agentId: profile.id, summary: "", tools: 0, profile }));
      return { snapshot: [...known, ...extra], asOf: definitions.asOf, sourceWatermark: definitions.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  return <div class="flex min-w-0 flex-col gap-3">
    <LibraryTabs value="agents" />
    <BrainPage title={t("agents.title")} description={t("agents.description")}>
      <PageStack>
        <WorkspaceSection title={t("agents.title")}>
          <ScreenRegion state={rows.state()} onRetry={() => void rows.refresh({ force: true })} emptyTitle={t("agents.empty.title")} emptyDescription={t("agents.empty.description")}>
            <div class="brain-queue" data-testid="agent-list"><For each={rows.state().data ?? []}>{(row) => <div data-testid="agent-row" data-agent={row.agentId}>
              <QueueRow title={titleize(row.agentId)} description={row.summary || row.agentId} icon="lucide-bot" tone={row.profile?.status.state === "failing" ? "red" : row.profile?.status.state === "working" ? "green" : "blue"}
                label={t("agents.row.open", { name: titleize(row.agentId) })}
                meta={<Show when={row.profile}>{(profile) => <span class="text-caption text-ink-gray-7">{t("agents.row.sessions", { live: profile().sessions.live, total: profile().sessions.total })}</span>}</Show>}
                trailing={<ActivityBadge status={row.profile?.status.state ?? "idle"} />}
                onClick={() => void navigate(agentHref(app.workspaceId(), row.agentId))} />
            </div>}</For></div>
          </ScreenRegion>
        </WorkspaceSection>
      </PageStack>
    </BrainPage>
  </div>;
}
