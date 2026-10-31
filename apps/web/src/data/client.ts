import type { CommandEnvelope, QueryRequest } from "@brain/contracts";

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
  return value;
}

export function query<T>(request: QueryRequest, signal?: AbortSignal): Promise<T> {
  return governor<T>("/v1/query", request, signal);
}

export function command<T>(request: CommandEnvelope): Promise<T> {
  return governor<T>("/v1/commands", request);
}
