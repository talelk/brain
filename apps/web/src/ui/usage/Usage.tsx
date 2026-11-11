import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog } from "@talelk/newui-molecules";
import type { BudgetUsage, Mission, UsageSummary, UsageView } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { useApp } from "../app-context";
import { count, formatTokens, formatUsd } from "../format";
import { Meter } from "../viz/Meter";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
type Figures = Pick<UsageSummary, "settledMicroUsd" | "reservedMicroUsd" | "settledTokens" | "reservedTokens" | "inputTokens" | "outputTokens" | "cachedInputTokens" | "estimated"> & { attempts?: number; openAttempts?: number };

/** The mission snapshot already carries its totals; show them with the same component as every other level. */
export const figuresOfMission = (usage: BudgetUsage, runningMembers = usage.runningMembers): Figures => ({ ...usage, attempts: undefined, openAttempts: runningMembers });

/** Reads one usage scope from the Governor; the browser only formats what the ledger totals say. */
export function useUsage(queryType: "usage.run" | "usage.task" | "usage.mission" | "usage.workspace", resourceId: () => string | undefined) {
  const app = useApp();
  return createScopedRead<UsageView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const id = resourceId();
      const response = await query<Envelope<UsageView>>({ queryType, workspaceId: scope.workspaceId, ...(id ? { resourceId: id } : {}) } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 10_000,
  });
}

/**
 * Tokens and dollars used, settled versus reserved, with estimated values and
 * the cache-read share labelled. Local models cost no dollars, so tokens lead;
 * a limit, when set, gets a meter. Nothing is shown as zero when it is unknown.
 */
export function UsageFigures(props: { label: string; usage: Figures; tokenLimit?: number; compact?: boolean }): JSX.Element {
  const total = () => props.usage.inputTokens + props.usage.outputTokens + props.usage.cachedInputTokens;
  const cacheShare = () => (total() > 0 ? Math.round((props.usage.cachedInputTokens / total()) * 100) : 0);
  const running = () => props.usage.openAttempts ?? 0;
  const empty = () => total() === 0 && props.usage.settledMicroUsd === 0 && props.usage.reservedMicroUsd === 0 && props.usage.reservedTokens === 0;
  return <section class="flex min-w-0 flex-col gap-1" aria-label={`${props.label} usage`} data-testid="usage-figures">
    <Show when={!empty()} fallback={<p class="text-interface text-ink-gray-7" data-testid="usage-none">{running() > 0 ? `${count(running(), "attempt")} running; usage is recorded when ${running() === 1 ? "it finishes" : "they finish"}.` : "No usage recorded yet."}</p>}>
      <p class="flex flex-wrap items-baseline gap-x-2 text-base-medium text-ink-gray-9">
        <span title={`${total().toLocaleString("en-GB")} tokens`} data-testid="usage-tokens">{formatTokens(total())} tokens</span>
        <span class="text-ink-gray-6" aria-hidden="true">·</span>
        <span data-testid="usage-dollars">{props.usage.settledMicroUsd === 0 && total() > 0 ? "$0 (local models report no cost)" : formatUsd(props.usage.settledMicroUsd)}</span>
        <Show when={props.usage.estimated}><Badge size="sm" theme="amber" label="includes estimates" /></Show>
      </p>
      <Show when={!props.compact && total() > 0}>
        <p class="text-caption text-ink-gray-7">{formatTokens(props.usage.inputTokens)} in · {formatTokens(props.usage.outputTokens)} out · {formatTokens(props.usage.cachedInputTokens)} read from cache ({cacheShare()}% of tokens)</p>
      </Show>
      <Show when={props.usage.reservedTokens > 0 || props.usage.reservedMicroUsd > 0}>
        <p class="text-caption text-ink-gray-7" data-testid="usage-reserved">Reserved for running work: {formatTokens(props.usage.reservedTokens)} tokens · {formatUsd(props.usage.reservedMicroUsd)}</p>
      </Show>
      <Show when={running() > 0 && !props.compact}><p class="text-caption text-ink-gray-6">{count(running(), "attempt")} still running; its usage is added when it finishes.</p></Show>
    </Show>
    <Show when={props.tokenLimit}>{(limit) => <Meter label={`${props.label} token ceiling`} settled={props.usage.settledTokens} reserved={props.usage.reservedTokens} limit={limit()} format={formatTokens} />}</Show>
  </section>;
}

/** Cost of one task for its Result card: actual settled usage, beside the plan's estimate when it has one. */
export function TaskUsage(props: { workItemId: string }): JSX.Element {
  const usage = useUsage("usage.task", () => props.workItemId);
  return <Show when={usage.state().data}>{(view) => <div class="rounded-card border border-outline-gray-1 bg-surface-gray-1 px-3 py-2" data-testid="task-usage">
    <UsageFigures label="Task" usage={view().usage} compact />
    <Show when={view().planEstimate?.maxMicroUsd !== undefined}><p class="text-caption text-ink-gray-6" data-testid="task-usage-estimate">Plan estimate (cost cap): up to {formatUsd(view().planEstimate?.maxMicroUsd)}; actual {formatUsd(view().usage.settledMicroUsd)}.</p></Show>
  </div>}</Show>;
}

/** The run's attempts: totals plus what the attempt in flight has reported so far. */
export function RunUsage(props: { runId: string }): JSX.Element {
  const usage = useUsage("usage.run", () => props.runId);
  return <Show when={usage.state().data}>{(view) => <div class="flex min-w-0 flex-col gap-2" data-testid="run-usage">
    <UsageFigures label="Run" usage={view().usage} />
    <Show when={(view().attemptRows ?? []).length > 0}>
      <ul class="flex flex-col gap-1 text-caption text-ink-gray-7" aria-label="Usage by attempt">
        <For each={view().attemptRows}>{(row, index) => <li data-testid="run-usage-attempt">
          Attempt {index() + 1}: {formatTokens(row.inputTokens + row.outputTokens + row.cachedInputTokens)} tokens · {formatUsd(row.microUsd)}{row.settled ? "" : " so far (still running)"}{row.estimated ? " · estimated" : ""}
        </li>}</For>
      </ul>
    </Show>
  </div>}</Show>;
}

const toMicro = (dollars: string): number | undefined => {
  const value = Number(dollars);
  return dollars.trim() !== "" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : undefined;
};
const toDollars = (micro?: number): string => (micro === undefined ? "" : String(micro / 1_000_000));

/** Workspace rollup on Missions: all usage in the workspace, and the daily and weekly spend cap with its raise control. */
export function WorkspaceUsage(props: { onChanged?: () => void }): JSX.Element {
  const app = useApp();
  const usage = useUsage("usage.workspace", () => undefined);
  const [editing, setEditing] = createSignal(false);
  const [daily, setDaily] = createSignal("");
  const [weekly, setWeekly] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const open = (cap?: { dailyMicroUsd?: number; weeklyMicroUsd?: number }) => { setDaily(toDollars(cap?.dailyMicroUsd)); setWeekly(toDollars(cap?.weeklyMicroUsd)); setError(""); setEditing(true); };
  async function save(): Promise<void> {
    setBusy(true); setError("");
    try {
      const dailyMicroUsd = toMicro(daily()), weeklyMicroUsd = toMicro(weekly());
      await app.run("workspace.spendCap.set", { ...(dailyMicroUsd !== undefined ? { dailyMicroUsd } : {}), ...(weeklyMicroUsd !== undefined ? { weeklyMicroUsd } : {}) });
      setEditing(false); await usage.refresh({ force: true }); props.onChanged?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The spend cap was refused."); }
    finally { setBusy(false); }
  }
  return <Show when={usage.state().data}>{(view) => <section class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-1 bg-surface-gray-1 p-3" aria-label="Workspace usage" data-testid="workspace-usage">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-6"><span class="lucide-gauge size-3.5" aria-hidden="true" />Usage by missions in this workspace</p>
      <Button size="sm" variant="ghost" iconLeft="lucide-sliders-horizontal" onClick={() => open(view().spendCap)}>Spend cap</Button>
    </div>
    <UsageFigures label="Workspace" usage={view().usage} compact />
    <p class="text-caption text-ink-gray-6">Interactive runs outside a mission are not included; open the run to see its own usage.</p>
    <Show when={view().spendCap} fallback={null}>{(cap) => <div class="flex min-w-0 flex-col gap-1.5" data-testid="spend-cap">
      <Show when={cap().dailyMicroUsd !== undefined} fallback={<p class="text-caption text-ink-gray-6">No daily spend cap. Last 24 hours: {formatUsd(cap().dailySpentMicroUsd)}.</p>}>
        <Meter label="Daily spend cap (last 24 hours)" settled={cap().dailySpentMicroUsd} reserved={0} limit={cap().dailyMicroUsd ?? 0} format={formatUsd} />
      </Show>
      <Show when={cap().weeklyMicroUsd !== undefined}><Meter label="Weekly spend cap (last 7 days)" settled={cap().weeklySpentMicroUsd} reserved={0} limit={cap().weeklyMicroUsd ?? 0} format={formatUsd} /></Show>
    </div>}</Show>
    <Dialog.Root open={editing()} onOpenChange={(next) => { if (!next) setEditing(false); }}>
      <Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>Workspace spend cap</Dialog.Title><Dialog.Description>When the dollars settled and reserved in the last 24 hours (or 7 days) reach the cap, missions pause until you raise it. Leave a field empty for no cap. Local models cost $0, so use a mission token ceiling to bound them.</Dialog.Description></Dialog.Header>
        <div class="flex flex-col gap-3 py-2">
          <TextInput label="Daily cap (US dollars)" inputMode="decimal" value={daily()} onInput={(event) => setDaily(event.currentTarget.value)} />
          <TextInput label="Weekly cap (US dollars)" inputMode="decimal" value={weekly()} onInput={(event) => setWeekly(event.currentTarget.value)} />
          <Show when={error()}><Alert theme="red" variant="outline" title="Not saved" description={error()} /></Show>
        </div>
        <Dialog.Footer class="flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" variant="solid" theme="blue" loading={busy()} onClick={() => void save()}>Save cap</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </section>}</Show>;
}

/**
 * The mission's spend and limits: tokens and dollars with the token ceiling,
 * and a dialog to change them. For a mission paused by budget the same dialog
 * raises the limits and resumes in one step, as an audited command pair.
 */
export function MissionUsage(props: { mission: Mission; onAct: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): JSX.Element {
  const app = useApp();
  const [editing, setEditing] = createSignal(false);
  const [tokens, setTokens] = createSignal("");
  const [dollars, setDollars] = createSignal("");
  const [minutes, setMinutes] = createSignal("");
  const [error, setError] = createSignal("");
  const workspace = useUsage("usage.workspace", () => undefined);
  const cap = () => workspace.state().data?.spendCap;
  const [capDaily, setCapDaily] = createSignal("");
  const [capWeekly, setCapWeekly] = createSignal("");
  const hasCap = () => cap()?.dailyMicroUsd !== undefined || cap()?.weeklyMicroUsd !== undefined;
  const budgetPaused = () => props.mission.state === "paused" && props.mission.pauseReason === "budget";
  const open = () => { setTokens(props.mission.budget.maxTokens === undefined ? "" : String(props.mission.budget.maxTokens)); setDollars(toDollars(props.mission.budget.maxMicroUsd)); setMinutes(props.mission.budget.maxWallClockMs === undefined ? "" : String(Math.round(props.mission.budget.maxWallClockMs / 60_000))); setCapDaily(toDollars(cap()?.dailyMicroUsd)); setCapWeekly(toDollars(cap()?.weeklyMicroUsd)); setError(""); setEditing(true); };
  async function save(resume: boolean): Promise<void> {
    const maxTokens = tokens().trim() === "" ? undefined : Math.round(Number(tokens()));
    const maxMicroUsd = toMicro(dollars());
    const maxWallClockMs = minutes().trim() === "" ? undefined : Math.round(Number(minutes()) * 60_000);
    if (maxWallClockMs !== undefined && (!Number.isFinite(maxWallClockMs) || maxWallClockMs < 0)) { setError("The time limit must be a number of minutes of working time, or empty for no limit."); return; }
    if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 0)) { setError("The token ceiling must be a whole number of tokens, or empty for no ceiling."); return; }
    const capChanged = hasCap() && (toMicro(capDaily()) !== cap()?.dailyMicroUsd || toMicro(capWeekly()) !== cap()?.weeklyMicroUsd);
    const { maxTokens: _t, maxMicroUsd: _u, maxWallClockMs: _w, ...rest } = props.mission.budget;
    setEditing(false);
    await props.onAct(async () => {
      if (capChanged) { const dailyMicroUsd = toMicro(capDaily()), weeklyMicroUsd = toMicro(capWeekly()); await app.run("workspace.spendCap.set", { ...(dailyMicroUsd !== undefined ? { dailyMicroUsd } : {}), ...(weeklyMicroUsd !== undefined ? { weeklyMicroUsd } : {}) }); await workspace.refresh({ force: true }); }
      const set = await app.run("mission.budget.set", { missionId: props.mission.missionId, budget: { ...rest, ...(maxTokens !== undefined ? { maxTokens } : {}), ...(maxMicroUsd !== undefined ? { maxMicroUsd } : {}), ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}) } }, { expectedVersion: props.mission.version });
      if (resume && set.accepted) await app.run("mission.resume", { missionId: props.mission.missionId });
    });
  }
  return <div class="flex min-w-0 flex-col gap-1" data-testid="mission-usage">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-base-medium">Usage</p>
      <Show when={props.mission.state !== "closed"}><Button size="sm" variant="ghost" iconLeft="lucide-sliders-horizontal" disabled={props.busy} onClick={open}>{budgetPaused() ? "Raise limits" : "Change limits"}</Button></Show>
    </div>
    <UsageFigures label="Mission" usage={figuresOfMission(props.mission.usage)} {...(props.mission.budget.maxTokens !== undefined ? { tokenLimit: props.mission.budget.maxTokens } : {})} />
    <Show when={props.mission.budget.maxTokens === undefined}><p class="text-caption text-ink-gray-6">No token ceiling is set.</p></Show>
    <Dialog.Root open={editing()} onOpenChange={(next) => { if (!next) setEditing(false); }}>
      <Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>{budgetPaused() ? "Raise this mission's limits" : "Mission limits"}</Dialog.Title><Dialog.Description>{budgetPaused() ? "This mission paused because a limit was reached (its time limit, its dollar budget, its token ceiling or the workspace spend cap). Raise what was reached, then resume." : "Brain stops starting new work when these are reached. Leave a field empty for no limit."}</Dialog.Description></Dialog.Header>
        <div class="flex flex-col gap-3 py-2">
          <TextInput label="Token ceiling (tokens)" inputMode="numeric" value={tokens()} onInput={(event) => setTokens(event.currentTarget.value)} />
          <TextInput label="Dollar budget (US dollars)" inputMode="decimal" value={dollars()} onInput={(event) => setDollars(event.currentTarget.value)} />
          <TextInput label="Time limit (minutes of working time, not counting waiting for a person)" inputMode="numeric" value={minutes()} onInput={(event) => setMinutes(event.currentTarget.value)} />
          <Show when={hasCap()}>
            <TextInput label="Workspace daily cap (US dollars, shared by all missions)" inputMode="decimal" value={capDaily()} onInput={(event) => setCapDaily(event.currentTarget.value)} />
            <TextInput label="Workspace weekly cap (US dollars, shared by all missions)" inputMode="decimal" value={capWeekly()} onInput={(event) => setCapWeekly(event.currentTarget.value)} />
          </Show>
          <Show when={error()}><Alert theme="red" variant="outline" title="Not saved" description={error()} /></Show>
        </div>
        <Dialog.Footer class="flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          <Show when={budgetPaused()}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-play" onClick={() => void save(true)}>Save and resume</Button></Show>
          <Button size="sm" variant={budgetPaused() ? "outline" : "solid"} theme="blue" onClick={() => void save(false)}>Save limits</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </div>;
}
