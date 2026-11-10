import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Icon } from "@talelk/newui-atoms";
import { Menu } from "@talelk/newui-molecules";
import { KanbanBoard, type KanbanColumn, type KanbanMove } from "@talelk/newui-organisms";
import type { WorkItem } from "@brain/contracts";
import { BOARD_COLUMNS, boardColumnOf, dragTargets, type BoardColumnId, type NextAction } from "./work-model";
import { WorkCard } from "./WorkCard";

interface Card { id: string; item: WorkItem }

/** Why a column refuses a drag, in plain words: the move exists, but through its own flow. */
function refusal(item: WorkItem, to: BoardColumnId): string {
  if (item.parked) return `${item.title} is parked; open it to retry, reassign or drop it.`;
  if (to === "done") return `Done needs verified evidence. Open ${item.title} and use Review to bind it.`;
  if (to === "blocked") return `Blocking needs a reason. Open ${item.title} and use Move work item.`;
  if (to === "in-progress" && item.state === "ready") return `Starting runs an agent. Use Start on ${item.title}.`;
  if (to === "ready") return `${item.title} can return to Ready only once its dependencies are verified done.`;
  return `${item.title} cannot move from ${item.state.replace("-", " ")} to ${to.replace("-", " ")}.`;
}

/**
 * The mission's work as a Kanban board (Ready, In progress, Review, Blocked,
 * Done) on the NewUI board. A card can be dragged only to the columns the
 * Governor accepts as a plain transition; every other move stays a button
 * (Start, Review, Hand off, Unblock). A card with no legal drag never lifts,
 * and the card menu lists exactly the same legal moves for the keyboard.
 */
export function WorkBoard(props: {
  items: readonly WorkItem[];
  ownerOf: (item: WorkItem) => string | undefined;
  estimateOf: (item: WorkItem) => number | undefined;
  handoffRequired: (item: WorkItem) => boolean;
  canDispatch: boolean;
  critical: ReadonlySet<string>;
  onOpen: (item: WorkItem) => void;
  onAction: (item: WorkItem, action: NextAction) => void;
  onMove: (item: WorkItem, to: BoardColumnId) => Promise<string | undefined>;
}): JSX.Element {
  const [pending, setPending] = createSignal<Record<string, BoardColumnId>>({});
  const [notice, setNotice] = createSignal<{ tone: "info" | "warn"; text: string }>();
  const cards = new Map<string, { version: number; card: Card }>();
  const cardOf = (item: WorkItem): Card => {
    const cached = cards.get(item.workItemId);
    // Same version, same card object: a poll does not rebuild every card's DOM.
    if (cached && cached.version === item.version && cached.card.item.state === item.state) return cached.card;
    const card = { id: item.workItemId, item };
    cards.set(item.workItemId, { version: item.version, card });
    return card;
  };
  const targets = (item: WorkItem) => dragTargets(item, props.items, props.canDispatch);
  const columnOf = (item: WorkItem) => pending()[item.workItemId] ?? boardColumnOf(item);
  const columns = createMemo<KanbanColumn<Card>[]>(() => BOARD_COLUMNS.map((column) => {
    const items = props.items.filter((item) => columnOf(item) === column.id)
      // Ready lists startable work before work still waiting on dependencies.
      .sort((a, b) => (a.state === "backlog" ? 1 : 0) - (b.state === "backlog" ? 1 : 0));
    return {
      id: column.id, name: column.name, items: items.map(cardOf),
      summary: <span title={column.hint}>{column.hint}</span>,
    };
  }));

  async function move(item: WorkItem, to: BoardColumnId): Promise<void> {
    if (!targets(item).includes(to)) { setNotice({ tone: "warn", text: refusal(item, to) }); return; }
    setPending((current) => ({ ...current, [item.workItemId]: to }));
    setNotice({ tone: "info", text: `Moving ${item.title} to ${BOARD_COLUMNS.find((column) => column.id === to)?.name ?? to}…` });
    const refused = await props.onMove(item, to);
    setPending((current) => { const next = { ...current }; delete next[item.workItemId]; return next; });
    setNotice(refused ? { tone: "warn", text: refused } : { tone: "info", text: `${item.title} moved to ${BOARD_COLUMNS.find((column) => column.id === to)?.name ?? to}.` });
  }

  // A card with no legal drag never lifts: its press is stopped before the
  // board's (delegated) drag handler sees it. Clicks still reach its buttons.
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const guard = (event: PointerEvent) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>("[data-kanban-card]");
      if (card?.querySelector("[data-kanban-locked]")) event.stopPropagation();
    };
    root?.addEventListener("pointerdown", guard, true);
    onCleanup(() => root?.removeEventListener("pointerdown", guard, true));
  });

  return <div ref={root} class="brain-work-board flex min-w-0 flex-col gap-2" data-testid="work-board">
    <p class="flex items-center gap-1.5 text-caption text-ink-gray-6">
      <span class="lucide-hand size-3.5" aria-hidden="true" />Drag a card where the move needs nothing else; Start, Review, Hand off and Done stay on the card.
    </p>
    <Show when={notice()}>{(entry) => <p role="status" class={`rounded-control px-2.5 py-1.5 text-caption ${entry().tone === "warn" ? "bg-surface-amber-1 text-ink-amber-8" : "bg-surface-gray-1 text-ink-gray-7"}`}>{entry().text}</p>}</Show>
    <KanbanBoard<Card> label="Work items" columns={columns()} itemLabel={(card) => card.item.title}
      onMove={(event: KanbanMove<Card>) => { if (event.from.column !== event.to.column) void move(event.item.item, event.to.column as BoardColumnId); }}
      emptyColumn={(column) => column.id === "done" ? "Verified work lands here." : column.id === "blocked" ? "Nothing is blocked." : "Nothing here."}
      renderActions={(card) => <Show when={targets(card.item).length > 0}>
        <Menu.Root onSelect={(value) => void move(card.item, value as BoardColumnId)}>
          <Menu.Trigger data-kanban-action="" aria-label={`Move ${card.item.title}`}
            class="flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-gray-6 hover:bg-surface-gray-3 hover:text-ink-gray-8 focus-visible:focus-ring max-lg:size-10">
            <Icon icon="lucide-ellipsis" class="size-4" />
          </Menu.Trigger>
          <Menu.Content>
            <Menu.Label>Move to</Menu.Label>
            <For each={targets(card.item)}>{(target) => <Menu.Item value={target}>{BOARD_COLUMNS.find((column) => column.id === target)?.name}</Menu.Item>}</For>
          </Menu.Content>
        </Menu.Root>
      </Show>}>
      {(card) => <div data-kanban-locked={targets(card.item).length === 0 ? "" : undefined} data-draggable={targets(card.item).length > 0 ? "true" : "false"}>
        <WorkCard item={card.item} items={props.items} owner={props.ownerOf(card.item)} estimateMinutes={props.estimateOf(card.item)}
          handoffRequired={props.handoffRequired(card.item)} canDispatch={props.canDispatch} critical={props.critical.has(card.item.workItemId)}
          onOpen={() => props.onOpen(card.item)} onAction={(action) => props.onAction(card.item, action)} />
      </div>}
    </KanbanBoard>
  </div>;
}
