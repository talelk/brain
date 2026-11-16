import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { ApiError, ApiResponse, CommandOutputs, CommandRequest, CommandType, ErrorCode, Problem, QueryOutputs, QueryRequest, QueryType } from "@brain/contracts";
import { invalidate, markFresh, subscribe } from "./live";

/** A refusal from the Governor, or a request that never reached it (`NETWORK`). */
export class ApiFailure extends Error {
  constructor(readonly code: ErrorCode | "NETWORK", message: string, readonly problems: readonly Problem[] = []) { super(message); }
}

async function post<O>(path: string, body: unknown): Promise<O> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiFailure("NETWORK", "");
  }
  const answer = (await response.json().catch(() => ({ error: { code: "INTERNAL", message: "" } satisfies ApiError }))) as ApiResponse<O>;
  if ("error" in answer) throw new ApiFailure(answer.error.code, answer.error.message, answer.error.problems);
  return answer.output;
}

export function query<T extends QueryType>(type: T, input: QueryRequest<T>): Promise<QueryOutputs[T]> {
  return post("/v1/query", { type, input });
}

/** Sends a command, then has every screen read again at once. */
export async function command<T extends CommandType>(type: T, input: CommandRequest<T>): Promise<CommandOutputs[T]> {
  const output = await post<CommandOutputs[T]>("/v1/command", { type, input, idempotencyKey: crypto.randomUUID() });
  invalidate(true);
  return output;
}

export interface Loaded<T> {
  /** The last answer; kept while a newer one is on its way. */
  readonly data: Accessor<T | undefined>;
  readonly error: Accessor<ApiFailure | undefined>;
  readonly refetch: () => void;
}

/** Reads `load` now, again whenever `key` changes, and again on every live change. `key` undefined means "nothing to read yet". */
export function useLive<T>(key: Accessor<string | undefined>, load: () => Promise<T>): Loaded<T> {
  const [data, setData] = createSignal<T>();
  const [error, setError] = createSignal<ApiFailure>();
  let generation = 0;
  let seen = "";
  const read = (): void => {
    if (key() === undefined) return;
    const mine = ++generation;
    load().then(
      (value) => {
        if (mine !== generation) return;
        // An answer equal to the one on screen changes nothing, so a quiet refresh never redraws the page.
        const text = JSON.stringify(value);
        if (text !== seen || data() === undefined) { seen = text; setData(() => value); }
        setError(undefined);
        markFresh(Date.now());
      },
      (reason: unknown) => { if (mine === generation) setError(reason instanceof ApiFailure ? reason : new ApiFailure("INTERNAL", String(reason))); },
    );
  };
  createEffect(on(key, (now, before) => {
    if (before !== undefined && now !== before) setData(undefined);
    read();
  }));
  onCleanup(subscribe(read));
  return { data, error, refetch: read };
}

/** One query, kept fresh. */
export function useQuery<T extends QueryType>(type: T, input: Accessor<QueryRequest<T> | undefined>): Loaded<QueryOutputs[T]> {
  const key = (): string | undefined => { const value = input(); return value === undefined ? undefined : JSON.stringify(value); };
  return useLive(key, () => query(type, input() as QueryRequest<T>));
}

export interface Action<A extends unknown[]> {
  /** Resolves true when the work succeeded; a refusal lands in `error`. */
  readonly run: (...args: A) => Promise<boolean>;
  readonly busy: Accessor<boolean>;
  readonly error: Accessor<ApiFailure | undefined>;
  readonly clear: () => void;
}

/** Wraps something a button does: busy while it runs, the refusal kept for the screen to show beside the button. */
export function useAction<A extends unknown[]>(work: (...args: A) => Promise<unknown>): Action<A> {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<ApiFailure>();
  const run = async (...args: A): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    setError(undefined);
    try { await work(...args); return true; }
    catch (reason) { setError(reason instanceof ApiFailure ? reason : new ApiFailure("INTERNAL", reason instanceof Error ? reason.message : String(reason))); return false; }
    finally { setBusy(false); }
  };
  return { run, busy, error, clear: () => setError(undefined) };
}

const artifacts = new Map<string, Promise<string>>();
/** The bytes of an artifact as text (a diff, a file an agent wrote). An artifact never changes, so it is read once. */
export function artifactText(digest: string): Promise<string> {
  let text = artifacts.get(digest);
  if (!text) {
    text = fetch(artifactUrl(digest), { credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new ApiFailure(response.status === 404 ? "NOT_FOUND" : "INTERNAL", "");
      return response.text();
    });
    text.catch(() => artifacts.delete(digest));
    artifacts.set(digest, text);
  }
  return text;
}
export const artifactUrl = (digest: string): string => `/v1/artifacts/${encodeURIComponent(digest)}`;
