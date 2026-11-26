import {
  BrainError, canonicalJsonBytes, commands, hmacSha256Hex, MAX_UPLOAD_STRING, queries, roleAtLeast, TOKEN_MAY,
  type Actor, type ApiRole, type Clock, type CommandInput, type CommandOutputs, type CommandType, type JsonValue, type Problem, type QueryInput, type QueryOutputs, type QueryType,
  type Role, type SnapshotManifest, type User,
} from "@brain/contracts";
import { z } from "zod";
import type { Auth } from "./auth/auth";
import { isTokenId } from "./auth/tokens";
import { accessOf } from "./access";
import { tx, type Db } from "./db";

/** Everything a module of the Governor works with. One per process (or per test). */
export interface Gov {
  readonly db: Db;
  readonly dataDir: string;
  readonly packsDir: string;
  readonly baseUrl: string;
  /** The address attempts reach the model gateway at: the base address, unless sandboxes reach the Governor by another one. */
  readonly gatewayUrl: string;
  readonly clock: Clock;
  /** Every request the Governor makes to another server (a model, GitHub, Teams, a project's repository) goes through this. */
  readonly fetch: typeof fetch;
  /** From `<data>/instance.key`: one key encrypts secrets, the other keys digests of tokens and requests. */
  readonly keys: { readonly secrets: Buffer; readonly digests: Buffer };
  /** The git store attempts fetch and push state commits at, and the key that signs their tokens; absent when `BRAIN_STORE_URL` is not set. */
  readonly store?: { readonly url: string; readonly privateKeyPem: string };
  readonly auth: Auth;
  readonly registry: Registry;
  /** Called inside the transaction that activates a snapshot (memory index, triggers). */
  readonly onActivate: Array<(workspaceId: string, manifest: SnapshotManifest) => void>;
  /** Called when a person's sessions end or they are deactivated: their open event streams end too. */
  readonly onSignedOut: Array<(userId: string) => void>;
}

export interface Ctx {
  readonly gov: Gov;
  readonly db: Db;
  /** The signed-in person, or an API token as a principal of its own; null only in a `public` entry. */
  readonly user: User | null;
  /** The same person as the actor of audit events. */
  readonly actor: Actor;
  /** The caller's role in `input.workspaceId`, for an entry that takes one. */
  readonly role: Role | null;
  now(): number;
  /** The address the request came from, for limits on repeated attempts. */
  readonly ip: string;
  /** Cookies to set on the HTTP response. */
  readonly cookies: string[];
}

/**
 * A command handler runs inside one transaction, together with the idempotency record, and appends its audit events there. Work that
 * cannot be done in a transaction (git, sign-in) goes in `prepare`, which runs first and hands its result to `run`.
 */
export type CommandHandler<T extends CommandType, P = undefined> =
  | ((ctx: Ctx, input: CommandInput<T>) => CommandOutputs[T])
  | {
    prepare?(ctx: Ctx, input: CommandInput<T>): Promise<P>;
    run(ctx: Ctx, input: CommandInput<T>, prepared: P): CommandOutputs[T];
    /** Work that needs the change to be committed first (a sign-in of the account `run` made); it may put cookies on `ctx.cookies`. */
    after?(ctx: Ctx, input: CommandInput<T>, prepared: P): Promise<void>;
    /** The answer holds a secret shown once: it is not kept, and a repeated key is refused instead of answered again. */
    secretOutput?: boolean;
  };
export type QueryHandler<T extends QueryType> = (ctx: Ctx, input: QueryInput<T>) => QueryOutputs[T] | Promise<QueryOutputs[T]>;

interface AnyCommand { prepare?: (ctx: Ctx, input: unknown) => Promise<unknown>; run: (ctx: Ctx, input: unknown, prepared: unknown) => unknown; after?: (ctx: Ctx, input: unknown, prepared: unknown) => Promise<void>; secretOutput?: boolean }
type AnyQuery = (ctx: Ctx, input: unknown) => unknown;

/** Where each module registers the commands and queries it implements. One without a handler answers NOT_IMPLEMENTED. */
export class Registry {
  readonly commands = new Map<string, AnyCommand>();
  readonly queries = new Map<string, AnyQuery>();
  command<T extends CommandType, P = undefined>(type: T, handler: CommandHandler<T, P>): void {
    if (this.commands.has(type)) throw new Error(`command ${type} is registered twice`);
    this.commands.set(type, (typeof handler === "function" ? { run: handler } : handler) as AnyCommand);
  }
  query<T extends QueryType>(type: T, handler: QueryHandler<T>): void {
    if (this.queries.has(type)) throw new Error(`query ${type} is registered twice`);
    this.queries.set(type, handler as AnyQuery);
  }
}

/** Who calls: the signed-in person, and where cookies for the response are collected. */
export interface Caller { readonly user: User | null; readonly cookies?: string[]; readonly ip?: string }

const commandBody = z.strictObject({ type: z.string(), input: z.unknown().optional(), idempotencyKey: z.string().min(8).max(200) });
const queryBody = z.strictObject({ type: z.string(), input: z.unknown().optional() });
const inputProblems = (error: z.ZodError): Problem[] => error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BrainError("INVALID_INPUT", `${what} is not valid`, inputProblems(parsed.error));
  return parsed.data;
}

/** An API token calls only what is named for tokens, whatever its role (docs/model.md, "API tokens"). */
function forTokens(user: User | null, may: readonly string[], type: string): void {
  if (user && isTokenId(user.id) && !may.includes(type)) throw new BrainError("FORBIDDEN", `An API token may not call ${type}`);
}

/** The caller's role in the workspace an entry is about; refuses a caller the entry is not for. A non-member is told the workspace does not exist. */
function authorize(gov: Gov, need: ApiRole, user: User | null, input: unknown, writes: boolean): Role | null {
  if (need === "public") return null;
  if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
  if (need === "instance-admin") {
    if (!user.instanceAdmin) throw new BrainError("FORBIDDEN", "This needs an administrator of this Brain");
    return null;
  }
  const workspaceId = (input as { workspaceId: string }).workspaceId;
  const row = accessOf(gov, user.id, workspaceId);
  if (!row) throw new BrainError("NOT_FOUND", "Workspace not found");
  if (!roleAtLeast(row.role, need)) throw new BrainError("FORBIDDEN", `This needs the ${need} role in the workspace`);
  if (writes && row.status !== "active") throw new BrainError("CONFLICT", "The workspace is archived");
  return row.role;
}

function context(gov: Gov, caller: Caller, role: Role | null): Ctx {
  return {
    gov, db: gov.db, user: caller.user, role, cookies: caller.cookies ?? [], ip: caller.ip ?? "unknown",
    actor: caller.user ? { kind: isTokenId(caller.user.id) ? "token" : "person", id: caller.user.id } : { kind: "system", id: "anonymous" },
    now: () => gov.clock.nowMs(),
  };
}

/** `POST /v1/command`: validate, authorize, answer a repeated key with the first answer, then run the handler and record the answer in one transaction. */
export async function runCommand(gov: Gov, caller: Caller, body: unknown): Promise<unknown> {
  const { type, input: rawInput, idempotencyKey } = parse(commandBody, body, "The command");
  const definition = (commands as Record<string, { role: ApiRole; input: z.ZodType }>)[type];
  if (!definition) throw new BrainError("INVALID_INPUT", `There is no command ${type}`);
  const input = parse(definition.input, rawInput ?? {}, `The input of ${type}`);
  forTokens(caller.user, TOKEN_MAY.commands, type);
  const ctx = context(gov, caller, authorize(gov, definition.role, caller.user, input, true));
  const handler = gov.registry.commands.get(type);
  if (!handler) throw new BrainError("NOT_IMPLEMENTED", `The command ${type} is not implemented yet`);

  // A public command has no caller to key a record by; setup, the only one, can succeed once anyway.
  const actorId = caller.user?.id;
  const requestDigest = hmacSha256Hex(gov.keys.digests, canonicalJsonBytes({ type, input: input as JsonValue }, MAX_UPLOAD_STRING));
  const replay = (): { output: unknown } | undefined => {
    if (!actorId) return undefined;
    const row = gov.db.prepare("SELECT command, request_digest AS digest, response_json AS response FROM idempotency WHERE actor_id=? AND key=?").get(actorId, idempotencyKey) as { command: string; digest: string; response: string } | undefined;
    if (!row) return undefined;
    if (row.command !== type || row.digest !== requestDigest) throw new BrainError("IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different command");
    if (row.response === "") throw new BrainError("CONFLICT", "The answer to this command was shown once; send it again with a new key");
    return { output: JSON.parse(row.response) };
  };
  const first = replay();
  if (first) return first.output;
  const prepared = handler.prepare ? await handler.prepare(ctx, input) : undefined;
  let ran = false;
  const output = tx(gov.db, () => {
    const again = replay();
    if (again) return again.output;
    const made = handler.run(ctx, input, prepared);
    ran = true;
    if (actorId) gov.db.prepare("INSERT INTO idempotency(actor_id, key, command, request_digest, response_json, created_at_ms) VALUES (?,?,?,?,?,?)").run(actorId, idempotencyKey, type, requestDigest, handler.secretOutput ? "" : JSON.stringify(made), ctx.now());
    return made;
  });
  if (ran) await handler.after?.(ctx, input, prepared);
  return output;
}

/** `POST /v1/query`: validate, authorize, read. */
export async function runQuery(gov: Gov, caller: Caller, body: unknown): Promise<unknown> {
  const { type, input: rawInput } = parse(queryBody, body, "The query");
  const definition = (queries as Record<string, { role: ApiRole; input: z.ZodType }>)[type];
  if (!definition) throw new BrainError("INVALID_INPUT", `There is no query ${type}`);
  const input = parse(definition.input, rawInput ?? {}, `The input of ${type}`);
  forTokens(caller.user, TOKEN_MAY.queries, type);
  const ctx = context(gov, caller, authorize(gov, definition.role, caller.user, input, false));
  const handler = gov.registry.queries.get(type);
  if (!handler) throw new BrainError("NOT_IMPLEMENTED", `The query ${type} is not implemented yet`);
  return handler(ctx, input);
}
