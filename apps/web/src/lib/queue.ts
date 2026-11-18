import type { Wait } from "@brain/contracts";
import { t, tn } from "../i18n";
import { dateTime, money } from "./format";

/** Why a task is not running yet, in words. */
export function waitText(wait: Wait): string {
  switch (wait.kind) {
    case "slot": return wait.ahead === 0 ? t("queue.wait.next") : tn("queue.wait.ahead", wait.ahead);
    case "running-tasks": return t("queue.wait.running-tasks", { used: wait.used, limit: wait.limit });
    case "daily-cap": return t("queue.wait.daily-cap", { spent: money(wait.spentMicroUsd), cap: money(wait.capMicroUsd) });
    case "capability": return t(`queue.wait.capability.${wait.what}`, { name: wait.missing });
    case "no-runner": return t("queue.wait.no-runner");
    case "task": return t("queue.wait.task", { title: wait.title });
    case "paused-workspace": return t("queue.wait.paused-workspace");
    case "paused-task": return t("queue.wait.paused-task");
    case "backoff": return t("queue.wait.backoff", { time: dateTime(wait.until), tries: wait.tries });
  }
}

/** Where a person raises a limit: the workspace's Settings, or the agent's form. */
export function limitPlace(slug: string, name: string, agent: string | undefined): string {
  return name.startsWith("agent.") && agent !== undefined ? `/w/${slug}/workspace/agents/${agent}?limit=${name}` : `/w/${slug}/workspace/settings?limit=${name}`;
}
