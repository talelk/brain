import type { CommandEnvelope, QueryRequest } from "@brain/contracts";

/** Called after every command the person sends: the live bus re-reads the screens at once instead of waiting for the stream's next wake. */
let afterMutation: (() => void) | undefined;
export function onGovernorMutation(listener: () => void): void { afterMutation = listener; }

export class GovernorError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

// Human credentials remain in Better Auth's HttpOnly cookies. Store no token,
// password, TOTP, approval note or protected response in browser persistence.
export async function governor<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string,string>): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  const value = await response.json() as T & { message?: string; detail?: string; code?: string };
  if (!response.ok) throw new GovernorError(response.status, value?.detail ?? value?.message ?? `Request failed (${response.status})`, value?.code);
  if (body !== undefined && path !== "/v1/query") afterMutation?.();
  return value;
}

export function query<T>(request: QueryRequest, signal?: AbortSignal): Promise<T> {
  return governor<T>("/v1/query", request, signal);
}

export function command<T>(request: CommandEnvelope): Promise<T> {
  return governor<T>("/v1/commands", request);
}
