import { createSignal, For, Show, type JSX } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import { LIMIT_DEFAULTS, MAX_ATTEMPTS, MAX_REPLY_TOKENS } from "@brain/contracts/limits";
import type { AgentFile, SnapshotManifest, Task } from "@brain/contracts";
import { command, query, useAction, useQuery } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t, tKey } from "../i18n";
import { agentToml, brainOf, brainToml, paths } from "../lib/files";
import { money } from "../lib/format";
import { limitPlace, waitText } from "../lib/queue";
import { Failure } from "./bits";

type Where = { kind: "brain"; field: "daily_spend_usd" | "running_tasks" | "per_day" } | { kind: "agent"; field: "turns" | "tokens" | "spend_usd" };
interface Row {
  readonly id: string;
  readonly label: string;
  /** The number a person may change, 0 meaning no cap; absent for a limit that is not edited here. */
  readonly value?: number;
  readonly shown: string;
  readonly used?: string;
  readonly from: string;
  readonly where?: Where;
}
const count = (value: number): string => (value === 0 ? t("limits.noCap") : value.toLocaleString());

/** The limits that apply to the workspace, or to one agent: each with its value, what is used, where it comes from, and a way to change it. `?limit=` opens one for change. */
export function LimitsPanel(props: { snapshot: SnapshotManifest; agent?: string; readOnly: boolean }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const [search] = useSearchParams<{ limit?: string }>();
  const queue = useQuery("queue", () => (props.agent === undefined ? {} : undefined));
  const [editing, setEditing] = createSignal<string | undefined>(search.limit);
  const [draft, setDraft] = createSignal("");
  const mine = (): { attemptsRunning: number } | undefined => session.overview.data()?.workspaces.find((workspace) => workspace.id === place.id());
  const brainFrom = (value: number, standard: number): string => (value === standard ? t("limits.from.default") : t("limits.from.brain"));
  const rows = (): Row[] => {
    const { limits, healing } = props.snapshot;
    if (props.agent !== undefined) {
      const agent = props.snapshot.agents[props.agent];
      if (!agent) return [];
      const from = (value: number, standard: number): string => (value === standard ? t("limits.from.default") : agent.source === "workspace" ? t("limits.from.agent", { name: props.agent as string }) : t("limits.from.pack", { pack: agent.source }));
      return [
        { id: "agent.turns", label: t("limit.agent.turns"), value: agent.limits.turns, shown: count(agent.limits.turns), from: from(agent.limits.turns, LIMIT_DEFAULTS.turns), where: { kind: "agent", field: "turns" } },
        { id: "agent.tokens", label: t("limit.agent.tokens"), value: agent.limits.tokens, shown: count(agent.limits.tokens), from: from(agent.limits.tokens, LIMIT_DEFAULTS.tokens), where: { kind: "agent", field: "tokens" } },
        { id: "agent.spend_usd", label: t("limit.agent.spend_usd"), value: agent.limits.spend_usd, shown: agent.limits.spend_usd === 0 ? t("limits.noCap") : money(agent.limits.spend_usd * 1_000_000), from: from(agent.limits.spend_usd, LIMIT_DEFAULTS.spend_usd), where: { kind: "agent", field: "spend_usd" } },
        { id: "reply", label: t("limit.reply"), shown: t("queue.run.tokens", { n: MAX_REPLY_TOKENS.toLocaleString() }), from: t("limits.from.fixed") },
      ];
    }
    const slots = (queue.data()?.runners ?? []).filter((runner) => runner.online);
    const total = slots.reduce((sum, runner) => sum + runner.slots, 0);
    const used = slots.reduce((sum, runner) => sum + (runner.slots - runner.freeSlots), 0);
    return [
      { id: "workspace.daily_spend_usd", label: t("limit.workspace.daily_spend_usd"), value: limits.daily_spend_usd, shown: limits.daily_spend_usd === 0 ? t("limits.noCap") : money(limits.daily_spend_usd * 1_000_000), used: t("limit.used.today", { spent: money(place.today.data()?.spend.todayMicroUsd ?? 0) }), from: brainFrom(limits.daily_spend_usd, LIMIT_DEFAULTS.daily_spend_usd), where: { kind: "brain", field: "daily_spend_usd" } },
      { id: "workspace.running_tasks", label: t("limit.workspace.running_tasks"), value: limits.running_tasks, shown: count(limits.running_tasks), used: String(mine()?.attemptsRunning ?? 0), from: brainFrom(limits.running_tasks, LIMIT_DEFAULTS.running_tasks), where: { kind: "brain", field: "running_tasks" } },
      { id: "healing", label: t("limit.healing"), value: healing.per_day, shown: count(healing.per_day), from: brainFrom(healing.per_day, LIMIT_DEFAULTS.healing_per_day), where: { kind: "brain", field: "per_day" } },
      { id: "slots", label: t("limit.slots"), shown: String(total), ...(total > 0 ? { used: t("limit.used.slots", { used, total }) } : {}), from: t("limits.from.runner", { name: "BRAIN_RUNNER_SLOTS" }) },
      { id: "step.max_rounds", label: t("limit.step.max_rounds"), shown: String(LIMIT_DEFAULTS.max_rounds), from: t("limits.from.play") },
      { id: "attempts", label: t("limit.attempts"), shown: String(MAX_ATTEMPTS), from: t("limits.from.fixed") },
      { id: "timeout", label: t("limit.timeout"), shown: "1 h", from: t("limits.from.runner", { name: "BRAIN_RUNNER_ATTEMPT_TIMEOUT_SECONDS" }) },
      { id: "sandbox", label: t("limit.sandbox"), shown: t("limit.sandbox.value"), from: t("limits.from.runner", { name: "BRAIN_RUNNER_SANDBOX_*" }) },
      { id: "upload", label: t("limit.upload"), shown: t("limit.upload.value"), from: t("limits.from.fixed") },
    ];
  };
  const save = useAction(async (row: Row) => {
    const value = Number(draft());
    if (!row.where || Number.isNaN(value) || value < 0) return;
    if (row.where.kind === "brain") {
      const brain = brainOf(props.snapshot);
      const next = row.where.field === "per_day" ? { ...brain, healing: { ...brain.healing, per_day: Math.round(value) } } : { ...brain, limits: { ...brain.limits, [row.where.field]: row.where.field === "running_tasks" ? Math.round(value) : value } };
      await command("file.write", { workspaceId: place.id(), files: [{ path: paths.brain, content: brainToml(next) }], message: `Change ${row.label}` });
    } else {
      const name = props.agent as string;
      const { source: _source, prompt: _prompt, ...file } = props.snapshot.agents[name] as AgentFile & { source: string; prompt: unknown };
      const prompt = await query("file.read", { workspaceId: place.id(), path: paths.prompt(name) });
      const changed = { ...file, limits: { ...file.limits, [row.where.field]: row.where.field === "spend_usd" ? value : Math.round(value) } };
      await command("file.write", { workspaceId: place.id(), files: [{ path: paths.agent(name), content: agentToml(changed) }, { path: paths.prompt(name), content: prompt.content }], message: `Change ${row.label} of ${name}` });
    }
    setEditing(undefined);
  });
  return (
    <section class="mb-6" aria-labelledby="limits-title" id="limits">
      <h3 id="limits-title" class="t-head text-ink">{t("limits.title")}</h3>
      <p class="mt-1 max-w-[62ch] t-small text-ink-2">{t("limits.text")}</p>
      <div class="mt-3 overflow-x-auto rounded-card border border-outline-gray-1">
        <table class="w-full min-w-[34rem] text-start t-small">
          <thead class="bg-surface-gray-2 text-ink-3"><tr><th class="px-3 py-2 text-start font-medium">{t("limits.col.limit")}</th><th class="px-3 py-2 text-start font-medium">{t("limits.col.value")}</th><th class="px-3 py-2 text-start font-medium">{t("limits.col.used")}</th><th class="px-3 py-2 text-start font-medium">{t("limits.col.from")}</th><th class="px-3 py-2"><span class="sr-only">{t("limits.change")}</span></th></tr></thead>
          <tbody class="divide-y divide-outline-gray-1">
            <For each={rows()}>
              {(row) => (
                <tr class={editing() === row.id ? "bg-lilac" : ""} data-limit={row.id}>
                  <th scope="row" class="px-3 py-2 text-start font-medium text-ink">{row.label}</th>
                  <td class="px-3 py-2 tabular-nums text-ink" dir="ltr">
                    <Show when={editing() === row.id} fallback={row.shown}>
                      <form class="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save.run(row); }}>
                        <TextInput size="md" type="number" min={0} step={row.where?.field === "spend_usd" || row.where?.field === "daily_spend_usd" ? "any" : 1} label={row.label} value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} autofocus />
                        <Button type="submit" variant="solid" theme="blue" size="md" loading={save.busy()}>{t("limits.save")}</Button>
                        <Button variant="ghost" size="md" onClick={() => setEditing(undefined)}>{t("limits.cancel")}</Button>
                      </form>
                    </Show>
                  </td>
                  <td class="px-3 py-2 text-ink-2">{row.used ?? "—"}</td>
                  <td class="px-3 py-2 text-ink-2" dir="auto">{row.from}</td>
                  <td class="px-3 py-2 text-end">
                    <Show when={row.where && !props.readOnly && editing() !== row.id}><Button variant="outline" size="sm" onClick={() => { setDraft(String(row.value ?? 0)); setEditing(row.id); }}>{t("limits.change")}</Button></Show>
                    <Show when={row.id === "slots"}><A href={place.to("/queue")} class="link">{t("nav.queue")}</A></Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Failure error={save.error()} class="mt-3" />
    </section>
  );
}

const spending = (name: string): boolean => name.endsWith("spend_usd");
/** What stopped a task or holds it back: the limit, its value, what was used, where it is set, and a button to the form that holds it. Nothing when no limit did. */
export function LimitNotice(props: { task: Task }): JSX.Element {
  const place = usePlace();
  const hit = (): { name: string; value: number; used: number | null; agent?: string | undefined } | undefined => {
    // A goal answers for its sub-tasks: the last limit that stopped an attempt anywhere under it, while it is failed or waits for a person because a sub-task failed.
    const broken = props.task.state === "failed" || props.task.needs?.kind === "failed-subtask";
    const failed = broken ? props.task.attempts.findLast((attempt) => attempt.state === "failed" && attempt.failure?.limit !== undefined)?.failure?.limit : undefined;
    if (failed) return failed;
    const need = props.task.needs;
    return need?.kind === "check" && props.task.round >= props.task.settings.maxRounds ? { name: "step.max_rounds", value: props.task.settings.maxRounds, used: props.task.round } : undefined;
  };
  const shown = (value: number | null, name: string): string => (value === null ? t("limit.hit.unknown") : spending(name) || name === "workspace.daily_spend_usd" ? money(value * 1_000_000) : value.toLocaleString());
  const where = (h: { name: string; agent?: string | undefined }): string =>
    h.name.startsWith("agent.") ? t("limits.from.agent", { name: h.agent ?? "" }) : h.name === "step.max_rounds" ? `plays/${props.task.play ?? ""}.toml` : h.name === "timeout" ? t("limits.from.runner", { name: "BRAIN_RUNNER_ATTEMPT_TIMEOUT_SECONDS" }) : h.name === "attempts" ? t("limits.from.fixed") : t("limits.from.brain");
  const raise = (h: { name: string; agent?: string | undefined }): string | undefined =>
    h.name === "attempts" || h.name === "timeout" ? undefined : h.name === "step.max_rounds" ? (props.task.play ? place.to(`/workspace/plays/${props.task.play}`) : undefined) : limitPlace(place.summary().slug, h.name, h.agent);
  return (
    <Show when={hit()}>
      {(h) => (
        <div class="mb-6 rounded-xl border border-amber-border bg-amber-soft px-4 py-3" role="note" data-testid="limit-notice">
          <p class="t-text font-medium text-ink">{t("limit.hit.title")}</p>
          <p class="mt-1 t-text text-ink-2" dir="auto">{t(h().name === "step.max_rounds" ? "limit.hit.rounds" : "limit.hit.text", { limit: tKey(`limit.${h().name}`, h().name), value: shown(h().value, h().name), used: shown(h().used, h().name), where: where(h()) })}</p>
          <Show when={raise(h())}>{(to) => <Button class="mt-2" variant="solid" theme="blue" size="md" route={to()}>{t("queue.raise")}</Button>}</Show>
        </div>
      )}
    </Show>
  );
}

/** A task that is queued says why it is not running: its place and the reason, with a button to the limit when a limit holds it. */
export function QueuedNotice(props: { task: Task }): JSX.Element {
  const place = usePlace();
  return (
    <Show when={props.task.queued}>
      {(queued) => (
        <div class="mb-6 rounded-xl bg-paper px-4 py-3" role="note" data-testid="queued-notice">
          <p class="t-text font-medium text-ink">{t("queue.task.waiting")}{queued().rank !== null ? ` · ${t("queue.rank", { n: queued().rank as number })}` : ""}</p>
          <p class="mt-1 t-text text-ink-2">{waitText(queued().wait)}</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <Show when={queued().wait.kind === "running-tasks" || queued().wait.kind === "daily-cap"}>
              <Button variant="solid" theme="blue" size="md" route={limitPlace(place.summary().slug, queued().wait.kind === "daily-cap" ? "workspace.daily_spend_usd" : "workspace.running_tasks", undefined)}>{t("queue.raise")}</Button>
            </Show>
            <Button variant="outline" size="md" route={place.to("/queue")}>{t("nav.queue")}</Button>
          </div>
        </div>
      )}
    </Show>
  );
}
