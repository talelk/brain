import { createMemo, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { BrainSession, WorkItem } from "@brain/contracts";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { t } from "../../i18n";
import { useApp } from "../app-context";
import { formatDateTime } from "../format";
import { missionHref, sameTitleHints } from "../mission-links";
import { ScreenRegion } from "../screen-region";
import { WorkBoard } from "./WorkBoard";
import { TaskSessionsContext } from "./TaskNow";
import { PRIORITIES, tagsOf, type BoardColumnId, type NextAction } from "./work-model";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** The work list reads at most one page; a busy workspace narrows it with a filter rather than losing older work silently. */
const PAGE = 100;
const ANY = "any";

/**
 * The work of every mission in a workspace as one Kanban board (#118), filtered by mission, team member, priority and tag.
 * The filters live in the address and narrow the read on the Governor, before its page limit, so an older matching task
 * is never hidden behind newer work. The options come from the unfiltered work, so a chosen filter never empties its own list.
 * Cards move exactly as on a mission's board: Review and Done are never a drag, and a task opens in its mission.
 */
export function WorkspaceBoard(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const param = (key: string): string => (typeof search[key] === "string" ? search[key] as string : "");
  const filters = createMemo(() => {
    const priority = param("priority");
    return {
      ...(param("mission") ? { missionId: param("mission") } : {}), ...(param("member") ? { memberId: param("member") } : {}),
      ...(PRIORITIES.some((entry) => entry === priority) ? { priority: priority as WorkItem["priority"] } : {}), ...(param("tag") ? { tag: param("tag") } : {}),
    };
  });
  const active = () => Object.keys(filters()).length > 0;
  const missions = app.useMissions();

  const work = createScopedRead<{ all: WorkItem[]; items: WorkItem[] }>({
    scope: app.scope,
    resource: () => JSON.stringify(filters()),
    load: async (scope, signal) => {
      const base = { queryType: "workItems.list", workspaceId: scope.workspaceId, limit: PAGE } as const;
      const [all, narrowed] = await Promise.all([
        query<Envelope<{ items: WorkItem[] }>>(base, signal),
        active() ? query<Envelope<{ items: WorkItem[] }>>({ ...base, ...filters() }, signal) : undefined,
      ]);
      return { snapshot: { all: all.snapshot.items, items: (narrowed ?? all).snapshot.items }, asOf: all.asOf, sourceWatermark: all.sourceWatermark };
    },
    isEmpty: (loaded) => loaded.all.length === 0,
  });
  // Sessions let each active task say what it is doing now, as on a mission's board.
  const sessions = createScopedRead<BrainSession[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: BrainSession[] }>>({ queryType: "sessions.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });

  const all = () => work.state().data?.all ?? [];
  const items = () => work.state().data?.items ?? [];
  const missionById = (id: string) => (missions.state().data ?? []).find((mission) => mission.missionId === id);
  const hints = createMemo(() => sameTitleHints(missions.state().data ?? [], formatDateTime));
  const missionLabel = (id: string): string => {
    const mission = missionById(id);
    if (!mission) return id;
    const title = hints().has(id) ? `${mission.title} · ${hints().get(id)}` : mission.title;
    return mission.state === "closed" ? t("board.mission-closed", { title }) : title;
  };

  /** A person, or a team member's agent by its member id: the id every filter and card names the same way. */
  const memberLabel = (item: WorkItem): string | undefined => {
    const assignment = item.assignment;
    if (!assignment) return undefined;
    return assignment.kind === "human" ? t("board.person", { name: app.personName(assignment.id) }) : assignment.id;
  };
  const memberOptions = createMemo(() => {
    const byId = new Map<string, string>();
    for (const item of all()) if (item.assignment) byId.set(item.assignment.id, memberLabel(item)!);
    const chosen = param("member");
    if (chosen && !byId.has(chosen)) byId.set(chosen, chosen);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  });
  const missionOptions = createMemo(() => {
    const ids = new Set(all().map((item) => item.missionId));
    const chosen = param("mission");
    if (chosen) ids.add(chosen);
    return [...ids].map((id) => ({ value: id, label: missionLabel(id) })).sort((a, b) => a.label.localeCompare(b.label));
  });
  const tagOptions = createMemo(() => {
    const names = new Set(tagsOf(all()));
    if (param("tag")) names.add(param("tag"));
    return [...names].sort().map((name) => ({ value: name, label: name }));
  });

  const choose = (key: "mission" | "member" | "priority" | "tag") => (value: string | null | undefined) => setSearch({ [key]: value && value !== ANY ? value : undefined }, { replace: true });
  const clear = () => setSearch({ mission: undefined, member: undefined, priority: undefined, tag: undefined }, { replace: true });

  const open = (item: WorkItem) => void navigate(`${missionHref(app.workspaceId(), item.missionId, "plan")}&item=${encodeURIComponent(item.workItemId)}`);
  const act = (item: WorkItem, action: NextAction) => {
    if (action.kind === "start") void navigate(`/w/${app.workspaceId()}/plays?originKind=work-item&originId=${encodeURIComponent(item.workItemId)}`);
    else if (action.kind === "follow") void navigate(missionHref(app.workspaceId(), item.missionId, "live"));
    else open(item);
  };
  /** A board drag: the same governed transition as on a mission's board, at the version the card was read at. */
  async function move(item: WorkItem, to: BoardColumnId): Promise<string | undefined> {
    let refused: string | undefined;
    try {
      const result = await app.run("workItem.transition", { workItemId: item.workItemId, state: to }, { expectedVersion: item.version });
      if (!result.accepted) refused = result.detail ?? "The move was refused";
    } catch (error) {
      refused = error instanceof Error ? error.message : "The move was refused";
    }
    await work.refresh({ force: true });
    return refused;
  }

  const priorityOptions = [{ value: ANY, label: t("board.any-priority") }, ...PRIORITIES.map((value) => ({ value, label: t(`work.priority.${value}` as "work.priority.urgent") }))];

  return <TaskSessionsContext.Provider value={() => sessions.state().data ?? []}>
    <div class="flex min-w-0 flex-col gap-4">
      <ScreenRegion state={work.state()} onRetry={() => void work.refresh({ force: true })} emptyTitle={t("board.empty-title")} emptyDescription={t("board.empty-description")}>
        <fieldset class="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2 xl:grid-cols-4" data-testid="board-filters">
          <legend class="sr-only">{t("board.filters")}</legend>
          <Select label={t("board.mission")} value={param("mission") || ANY} onValueChange={choose("mission")}
            options={[{ value: ANY, label: t("board.all-missions") }, ...missionOptions()]} />
          <Select label={t("board.member")} value={param("member") || ANY} onValueChange={choose("member")}
            options={[{ value: ANY, label: t("board.all-members") }, ...memberOptions()]} />
          <Select label={t("board.priority")} value={param("priority") || ANY} onValueChange={choose("priority")} options={priorityOptions} />
          <Select label={t("board.tag")} value={param("tag") || ANY} onValueChange={choose("tag")}
            options={[{ value: ANY, label: t("board.any-tag") }, ...tagOptions()]} />
        </fieldset>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-caption text-ink-gray-6" role="status" data-testid="board-count">{t("board.counts", { shown: items().length, total: all().length })}</p>
          <Show when={active()}><Button size="sm" variant="outline" iconLeft="lucide-x" onClick={clear}>{t("board.clear")}</Button></Show>
        </div>
        <Show when={items().length >= PAGE}><p class="rounded-control bg-surface-amber-1 px-2.5 py-1.5 text-caption text-ink-amber-8" role="note">{t("board.capped", { count: PAGE })}</p></Show>
        <Show when={items().length > 0} fallback={<div class="flex flex-col items-start gap-2 rounded-card border border-outline-gray-1 p-4" data-testid="board-none">
          <p class="text-base-medium text-ink-gray-9">{t("board.none-title")}</p>
          <p class="text-interface text-ink-gray-7">{t("board.none-description")}</p>
        </div>}>
          <WorkBoard items={items()} context={all()} ownerOf={memberLabel} estimateOf={() => undefined} handoffRequired={() => false} canDispatch={app.canDispatch()}
            critical={new Set()} missionOf={(item) => ({ title: missionLabel(item.missionId), href: missionHref(app.workspaceId(), item.missionId, "plan") })}
            onOpen={open} onAction={act} onMove={move} />
        </Show>
      </ScreenRegion>
    </div>
  </TaskSessionsContext.Provider>;
}
