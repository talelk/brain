import { Show, createContext, useContext } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { BrainSession, WorkItem } from "@brain/contracts";
import { createNow, EtaBandView } from "../console/NowLine";
import { etaBand, taskNowLine } from "../console/doing-now";

/** The workspace's sessions, provided by the screen that lists tasks, so every task row can say what its session is doing. */
export const TaskSessionsContext = createContext<Accessor<readonly BrainSession[]>>();

const LIVE = ["starting", "running", "waiting", "stopping"];

/**
 * One plain sentence and the ETA band under an active task (#61). Only the
 * session's and the task's state are at hand here, so the sentence is the
 * state-derived one; the Live console adds what the transcript shows. A task
 * that is not being worked on shows nothing.
 */
export function TaskNowLine(props: { item: WorkItem; estimateMinutes?: number }): JSX.Element {
  const sessions = useContext(TaskSessionsContext);
  const now = createNow();
  const session = () => (sessions?.() ?? []).filter((entry) => entry.workItemId === props.item.workItemId && LIVE.includes(entry.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const active = () => props.item.state === "in-progress" || props.item.state === "review";
  const line = () => taskNowLine(props.item.state, session()?.state);
  const band = () => etaBand({ ...(props.estimateMinutes !== undefined ? { estimatedMinutes: props.estimateMinutes } : {}), ...(session() ? { startedAt: session()!.createdAt } : {}), nowMs: now() });
  return <Show when={active() && line()}>{(text) => <div class="flex min-w-0 flex-col gap-1 text-caption text-ink-gray-7" data-testid="task-now">
    <p class="flex items-start gap-1.5"><span class="brain-live-dot mt-1.5 size-1.5 shrink-0 rounded-full bg-surface-green-7" aria-hidden="true" />{text()}</p>
    <Show when={session() || props.estimateMinutes}><EtaBandView band={band()} /></Show>
  </div>}</Show>;
}
