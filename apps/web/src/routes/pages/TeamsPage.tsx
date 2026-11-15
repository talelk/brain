import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput, Textarea } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { AgentCatalogEntry, StandingTeam, TeamMember } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { standingTeamsRead } from "../../data/standing-teams";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { FormSheet } from "../../ui/components/BrainForm";
import { DisclosureCard } from "../../ui/components/primitives";
import { LibraryTabs } from "../../ui/components/LibraryTabs";
import { TeamSection } from "../../ui/components/PlanTeamEditor";
import { agentFits, memberLabel, type AgentFit } from "../../ui/work/plan-team";
import { titleize } from "../../ui/format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
type Draft = { id?: string; version?: number; name: string; description: string; members: TeamMember[]; coordinator: string };
const blank = (): Draft => ({ name: "", description: "", members: [], coordinator: "" });
const NONE = "__none";

/**
 * `/w/:id/library/teams` (ADR 0056): standing teams, a place inside the Library. A standing team is a named set of roles bound to agent
 * definitions and engines. A plan or a Play start copies its members into that mission's plan; the team stays a source, never a link.
 */
export default function TeamsPage(): JSX.Element {
  const app = useApp();
  const teams = createScopedRead<StandingTeam[]>({ scope: app.scope, load: async (scope, signal) => standingTeamsRead(scope.workspaceId, signal), isEmpty: (items) => items.length === 0 });
  const agents = createScopedRead<AgentFit[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<Envelope<{ items: AgentCatalogEntry[] }>>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: agentFits(view.snapshot.items), asOf: view.asOf, sourceWatermark: view.sourceWatermark };
    },
  });
  const [draft, setDraft] = createSignal<Draft | undefined>();
  const [archiving, setArchiving] = createSignal<StandingTeam | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const active = () => (teams.state().data ?? []).filter((team) => team.state === "active");
  const archived = () => (teams.state().data ?? []).filter((team) => team.state === "archived");
  const open = (next: Draft | undefined) => { setError(""); setDraft(next); };
  const edit = (team: StandingTeam) => open({ id: team.standingTeamId, version: team.version, name: team.name, description: team.description ?? "", members: team.members.map((member) => ({ ...member })), coordinator: team.coordinatorMemberId ?? "" });
  const invalid = () => { const current = draft(); return !current || !current.name.trim() || current.members.length === 0; };

  async function save(): Promise<void> {
    const current = draft();
    if (!current || busy()) return;
    if (invalid()) { setError(current.members.length === 0 ? t("teams.form.members-needed") : t("teams.form.name-needed")); return; }
    setBusy(true); setError("");
    try {
      const receipt = current.id
        ? await app.run("standingTeam.update", { standingTeamId: current.id, name: current.name.trim(), description: current.description.trim(), members: current.members, coordinatorMemberId: current.coordinator || null }, { expectedVersion: current.version })
        : await app.run("standingTeam.create", { name: current.name.trim(), ...(current.description.trim() ? { description: current.description.trim() } : {}), members: current.members, ...(current.coordinator ? { coordinatorMemberId: current.coordinator } : {}) });
      if (!receipt.accepted) throw new Error(receipt.detail ?? t("teams.not-saved"));
      setDraft(undefined);
      await teams.refresh({ force: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("teams.not-saved")); } finally { setBusy(false); }
  }
  async function archive(): Promise<void> {
    const team = archiving();
    if (!team || busy()) return;
    setBusy(true); setError("");
    try {
      const receipt = await app.run("standingTeam.archive", { standingTeamId: team.standingTeamId }, { expectedVersion: team.version });
      if (!receipt.accepted) throw new Error(receipt.detail ?? t("teams.not-archived"));
      setArchiving(undefined);
      await teams.refresh({ force: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("teams.not-archived")); } finally { setBusy(false); }
  }

  const card = (team: StandingTeam, isActive: boolean): JSX.Element => <li class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4" data-testid={isActive ? "standing-team" : "standing-team-archived"} data-team-name={team.name}>
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-0.5">
        <h3 class="break-words text-base-medium text-ink-gray-9">{team.name}</h3>
        <Show when={team.description}><p class="break-words text-interface text-ink-gray-7">{team.description}</p></Show>
      </div>
      <Show when={isActive} fallback={<Badge variant="outline" theme="gray" label={t("teams.archived-badge")} />}>
        <div class="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" iconLeft="lucide-pencil" aria-label={t("teams.edit-named", { name: team.name })} disabled={!app.canDispatch()} onClick={() => edit(team)}>{t("teams.edit")}</Button>
          <Button size="sm" variant="ghost" theme="red" iconLeft="lucide-archive" aria-label={t("teams.archive-named", { name: team.name })} disabled={!app.canDispatch()} onClick={() => { setError(""); setArchiving(team); }}>{t("teams.archive")}</Button>
        </div>
      </Show>
    </div>
    <p class="text-caption text-ink-gray-6">{t("teams.members", { n: team.members.length })}{team.coordinatorMemberId ? ` · ${t("teams.coordinator", { member: team.coordinatorMemberId })}` : ""}</p>
    <ul class="flex min-w-0 flex-col gap-1">
      <For each={team.members}>{(member) => <li class="flex min-w-0 flex-wrap items-center gap-x-2 text-interface text-ink-gray-8"><span class="lucide-bot size-4 shrink-0 text-ink-gray-6" aria-hidden="true" /><span class="font-medium">{memberLabel(member)}</span><span class="text-ink-gray-6">{t("plan.team.runs-on", { agent: titleize(member.agentId), engine: member.engine })}</span></li>}</For>
    </ul>
  </li>;

  return <div class="flex min-w-0 flex-col gap-3">
    <LibraryTabs value="teams" />
    <BrainPage title={t("teams.title")} description={t("teams.description")}
      actions={<Button variant="solid" theme="blue" iconLeft="lucide-users-round" disabled={!app.canDispatch()} onClick={() => open(blank())}>{t("teams.new")}</Button>}>
      <PageStack>
        <p class="flex items-start gap-2 text-interface text-ink-gray-7" data-testid="teams-copy-note"><span class="lucide-copy mt-0.5 size-4 shrink-0" aria-hidden="true" />{t("teams.copy-note")}</p>
        <WorkspaceSection title={t("teams.list.title")} description={t("teams.list.description")}>
          <ScreenRegion state={teams.state()} onRetry={() => void teams.refresh({ force: true })} emptyTitle={t("teams.empty.title")} emptyDescription={t("teams.empty.description")}
            emptyAction={<Button variant="outline" iconLeft="lucide-users-round" disabled={!app.canDispatch()} onClick={() => open(blank())}>{t("teams.new")}</Button>}>
            <ul class="grid min-w-0 gap-3 md:grid-cols-2" data-testid="standing-teams">
              <For each={active()}>{(team) => card(team, true)}</For>
            </ul>
            <Show when={archived().length}>
              <div class="mt-3"><DisclosureCard label={t("teams.archived", { n: archived().length })}><ul class="grid min-w-0 gap-3 md:grid-cols-2" data-testid="standing-teams-archived"><For each={archived()}>{(team) => card(team, false)}</For></ul></DisclosureCard></div>
            </Show>
          </ScreenRegion>
        </WorkspaceSection>
      </PageStack>
    </BrainPage>

    <FormSheet size="xl" open={draft() !== undefined} onClose={() => open(undefined)} title={draft()?.id ? t("teams.form.edit-title", { name: draft()?.name ?? "" }) : t("teams.form.create-title")}
      description={t("teams.copy-note")} submit={draft()?.id ? t("teams.form.save") : t("teams.form.create")} icon="lucide-check" busy={busy()} disabled={!app.canDispatch()} error={error()} errorTitle={t("teams.not-saved")} onSubmit={save}>
      <Show when={draft()}>{(current) => <>
        <TextInput label={t("teams.form.name")} value={current().name} required onInput={(event) => setDraft({ ...current(), name: event.currentTarget.value })} />
        <Textarea label={t("teams.form.description")} value={current().description} rows={2} onInput={(event) => setDraft({ ...current(), description: event.currentTarget.value })} />
        <TeamSection team={current().members} tasks={[]} agents={agents.state().data} locked={new Set()} title={t("teams.form.members.title")} description={t("teams.form.members.description")} empty={t("teams.form.members-needed")}
          onChange={(members) => setDraft({ ...current(), members, coordinator: members.some((member) => member.memberId === current().coordinator) ? current().coordinator : "" })} />
        <Select label={t("teams.form.coordinator")} description={t("teams.form.coordinator.hint")} value={current().coordinator || NONE} disabled={current().members.length === 0}
          options={[{ value: NONE, label: t("teams.form.no-coordinator") }, ...current().members.map((member) => ({ value: member.memberId, label: memberLabel(member) }))]}
          onValueChange={(value) => setDraft({ ...current(), coordinator: !value || value === NONE ? "" : value })} />
      </>}</Show>
    </FormSheet>

    <FormSheet centered open={archiving() !== undefined} onClose={() => setArchiving(undefined)} title={t("teams.archive-title", { name: archiving()?.name ?? "" })} description={t("teams.archive-body")}
      submit={t("teams.archive-confirm")} icon="lucide-archive" theme="red" busy={busy()} disabled={!app.canDispatch()} error={error()} errorTitle={t("teams.not-archived")} onSubmit={archive}>
      <p class="text-interface text-ink-gray-8">{t("teams.archive-detail")}</p>
    </FormSheet>
  </div>;
}
