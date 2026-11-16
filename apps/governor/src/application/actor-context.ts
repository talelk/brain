import { AsyncLocalStorage } from "node:async_hooks";
import type { ActorContext } from "@brain/contracts";

/**
 * Who is doing what, for the event record (ADR 0032, #148). Every event the store writes takes its actor from the
 * scope the work runs in, never from the call site: the command funnel scopes a command to its caller, the Governor's
 * own passes scope themselves to a named system principal, and a runner protocol call is scoped to the runner.
 */
export type EventActorKind = ActorContext["kind"] | "system";

export interface EventActor {
  readonly principalId: string;
  readonly kind: EventActorKind;
  /** The attempt (the session's run of an agent step) the principal acted through, when there is one. */
  readonly attemptId?: string;
  /** The person a machine principal acts for. Never set for a person's own action. */
  readonly actingFor?: string;
}

/** Stands for "no actor was recorded": the column default. A row carrying it is a defect; the store never writes it itself in a test run. */
export const UNATTRIBUTED = "system:unattributed";

const scope = new AsyncLocalStorage<EventActor>();

/** Runs `fn` (and everything it starts) with `actor` as the actor of every event it writes; replaces any enclosing scope. */
export function actingAs<T>(actor: EventActor, fn: () => T): T {
  return scope.run(actor, fn);
}

export function currentEventActor(): EventActor | undefined {
  return scope.getStore();
}

/** A named Governor principal: timers, maintenance, watchdog, projector, schedulers, webhook deliveries. */
export function systemActor(name: string): EventActor {
  return { principalId: `system:${name}`, kind: "system" };
}

export function runnerActor(runnerId: string, attemptId?: string): EventActor {
  return { principalId: runnerId, kind: "runner", ...(attemptId ? { attemptId } : {}) };
}

/**
 * The event actor of a command caller. A session credential (kind agent) is its own principal acting for the owner
 * through its attempt. The Governor's own service dispatches (service credential) are the Governor acting for the
 * person the work belongs to, never that person.
 */
export function eventActorOf(actor: ActorContext): EventActor {
  if (actor.kind === "agent") return { principalId: actor.actorId, kind: "agent", ...(actor.attemptId ? { attemptId: actor.attemptId } : {}), ...(actor.delegatedBy ? { actingFor: actor.delegatedBy } : {}) };
  if (actor.authMethod === "service-credential") {
    const onBehalf = actor.delegatedBy ?? (actor.actorId.startsWith("system:") || actor.actorId === "governor" ? undefined : actor.actorId);
    return { principalId: "system:governor", kind: "system", ...(onBehalf ? { actingFor: onBehalf } : {}) };
  }
  return { principalId: actor.actorId, kind: actor.kind, ...(actor.attemptId ? { attemptId: actor.attemptId } : {}), ...(actor.delegatedBy ? { actingFor: actor.delegatedBy } : {}) };
}

type AnyMethod = (this: unknown, ...args: never[]) => unknown;

/**
 * Scopes named methods of a service to an actor, so every entry point that is not a command (a timer's pass, a runner
 * protocol call, a Brain facade method) names who it acts as in one list instead of at each of its emit sites. The
 * actor is fixed, or computed from the call's arguments (a runner call is the runner; a call that takes a caller is
 * the caller). The scope replaces whatever scope the caller runs in: work a command starts is not the command's actor's.
 * `ifAbsent` is for the engine's callbacks, which run inside whoever caused them (a runner's completion, a person's
 * cancel) and are the Governor's own only when nothing else is acting.
 */
export function scopeMethods(target: object, scopes: Readonly<Record<string, EventActor | ((...args: never[]) => EventActor)>>, options: { readonly ifAbsent?: boolean } = {}): void {
  const methods = target as Record<string, unknown>;
  for (const name of Object.keys(scopes)) {
    const original = methods[name] as AnyMethod | undefined;
    if (typeof original !== "function") throw new Error(`cannot scope ${name}: not a method`);
    const who = scopes[name]!;
    methods[name] = function scoped(this: unknown, ...args: never[]): unknown {
      if (options.ifAbsent && scope.getStore()) return original.apply(this, args);
      return actingAs(typeof who === "function" ? who(...args) : who, () => original.apply(this, args));
    };
  }
}

/** True in a test run: an event written outside any actor scope then throws instead of recording the sentinel. */
export function strictActors(): boolean {
  return process.env["VITEST"] !== undefined || process.env["NODE_ENV"] === "test";
}
