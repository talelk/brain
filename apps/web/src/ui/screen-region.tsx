import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Alert } from "@talelk/newui-molecules";
import { DataState } from "@talelk/newui-organisms";
import type { ScreenState } from "../data/screens";

/**
 * The one region contract for every data screen (document 21).
 *
 * Each of the eight declared statuses renders a distinct, task-specific
 * result: a skeleton while loading, an explanation plus an action when an
 * authorized read is empty, a clear cleared-content message on denial, and a
 * stale label with a refresh control when the server cannot be reached.
 */
export function ScreenRegion<T>(props: {
  state: ScreenState<T>;
  /** What is empty and what to do about it; never a generic "no data". */
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: JSX.Element;
  onRetry?: () => void;
  skeleton?: "rows" | "cards" | "chart";
  /** Extra warning shown above healthy content (degraded/unknown outcomes). */
  warning?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  const state = () => props.state;
  return (
    <DataState
      status={
        state().status === "loading" ? "loading"
          : state().status === "empty-authorized" ? "empty"
            : state().status === "ready" || state().status === "stale" ? "ready"
              : "error"
      }
      skeleton={props.skeleton ?? "rows"}
      title={state().status === "empty-authorized" ? props.emptyTitle : undefined}
      description={state().status === "empty-authorized" ? props.emptyDescription : undefined}
      action={state().status === "empty-authorized" ? props.emptyAction : undefined}
      error={
        state().status === "ready" || state().status === "stale" ? undefined
          : state().status === "no-access" ? <>This content is no longer available to your account. Cached private details were cleared, so <strong>Back</strong> cannot reveal them.</>
            : state().status === "offline" ? <>Governor is unreachable while you are offline. {state().error ?? ""}</>
              : state().status === "retry" ? <>Governor could not complete this read. {state().error ?? ""}</>
                : <span/>
      }
      onRetry={state().status === "retry" || state().status === "offline" ? props.onRetry : undefined}
    >
      <Show when={props.warning}>{props.warning}</Show>
      <Show when={state().status === "stale"}>
        {/* Failure retains the last authorized snapshot, but says so. */}
        <Alert theme="amber" variant="outline" title="Showing the last authorized result" description="The Governor could not be reached, so this data may be out of date. Effect actions are disabled until it is reachable again." />
      </Show>
      {props.children}
    </DataState>
  );
}

/** Server-bound date text: locale-formatted, absolute tooltip, never browser expiry. */
export function DateText(props: { value?: string; asOf?: string; tone?: "expired" | "upcoming" }): JSX.Element {
  const formatted = () => (props.value ? new Date(props.value).toLocaleString() : "—");
  return (
    <span title={props.value ? `Absolute time: ${props.value}` : undefined}>{formatted()}</span>
  );
}

/** Freshness from the server clock only; the browser clock never decides authority. */
export function isFreshFromServer(expiresAt: string | undefined, asOf: string | undefined): boolean {
  if (!expiresAt) return true;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return false;
  const now = asOf ? Date.parse(asOf) : 0;
  if (!Number.isFinite(now) || now === 0) return false; // no server clock = no authority claim
  return expiry > now;
}
