import type { ActorContext, CommandStepUpChallenge, JsonValue, StepUpEvidence } from "@brain/contracts";
import { commandDef, domainDigest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { resolveActor, requireWorkspaceRead, scopesForPrincipal, type ResolvedActor } from "../../application/authz";
import { assertHumanIdentity, type BrainAuth } from "../identity/index";

/**
 * Step-up for administrative commands (ADR 0045). The approval step-up of ADR 0024 is bound to one approval; this one is bound to one command: the
 * person's session, the command type, its workspace and the digest of its exact payload. The challenge becomes evidence once verified (a current TOTP
 * code when two-factor is required) and the command it names spends it, once, inside its own transaction.
 */
export const STEP_UP_COMMANDS: ReadonlySet<string> = new Set(["workspace.autonomyCeiling.set", "workspace.sessions.stopAll"]);

const VALID_MS = 300_000;

/** What the evidence is bound to: the command, its workspace and its payload without the evidence reference itself. */
function commandSubject(commandType: string, workspaceId: string, payload: JsonValue): string {
  const facts = { ...(payload as Record<string, JsonValue>) };
  delete facts["stepUpEvidenceId"];
  return domainDigest("brain:command-step-up:v1", { commandType, workspaceId, payload: facts });
}

export function createCommandChallenge(store: Store, auth: BrainAuth, identity: ResolvedActor, request: { commandType: string; workspaceId: string; payload: JsonValue }): CommandStepUpChallenge {
  assertHumanIdentity(store, auth, identity, auth.requireTwoFactor);
  const { actor, sessionDigest, humanSession } = identity;
  const def = commandDef(request.commandType);
  if (!STEP_UP_COMMANDS.has(request.commandType) || !def) throw new BrainDomainError("INVALID_ARGUMENT", `${request.commandType} does not take a step-up`);
  requireWorkspaceRead(store, actor, request.workspaceId);
  if (!scopesForPrincipal(store, actor.actorId, actor.organizationId, request.workspaceId).includes(def.scope)) throw new BrainDomainError("FORBIDDEN", `missing scope ${def.scope} for ${request.commandType}`);
  const pending = store.control.prepare("SELECT COUNT(*) AS n FROM command_step_ups WHERE actor_id=? AND auth_session_digest=? AND expires_at_ms>? AND verified_at_ms IS NULL").get(actor.actorId, sessionDigest, store.now()) as { n: number };
  if (pending.n >= 5) throw new BrainDomainError("RATE_LIMITED", "too many pending step-up challenges");
  const id = store.id("cmdstep");
  const subject = commandSubject(request.commandType, request.workspaceId, request.payload);
  const expires = store.now() + VALID_MS;
  store.control.prepare("INSERT INTO command_step_ups(id,actor_id,auth_session_digest,command_type,workspace_id,subject_digest,expires_at_ms,auth_session_id,auth_user_id,factor_digest,auth_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, actor.actorId, sessionDigest, request.commandType, request.workspaceId, subject, expires, humanSession!.sessionId, humanSession!.userId, humanSession!.factorDigest ?? null, actor.authGeneration);
  return { challengeId: id, commandType: request.commandType, subjectDigest: subject, expiresAt: iso(expires), method: auth.requireTwoFactor ? "totp" : "session" };
}

interface StepUpRow {
  actor_id: string; auth_session_digest: string; command_type: string; workspace_id: string; subject_digest: string; expires_at_ms: number; attempts: number;
  verified_at_ms: number | null; method: string | null; factor_digest: string | null; auth_generation: number; auth_session_id: string; auth_user_id: string;
  consumed_at_ms: number | null; revoked_at_ms: number | null;
}

export async function verifyCommandChallenge(store: Store, auth: BrainAuth, identity: ResolvedActor, challengeId: string, code: string, headers: Headers): Promise<StepUpEvidence> {
  assertHumanIdentity(store, auth, identity, auth.requireTwoFactor);
  const { actor, sessionDigest, humanSession } = identity;
  const row = store.inTx(store.control, () => {
    const found = store.control.prepare("SELECT * FROM command_step_ups WHERE id=?").get(challengeId) as StepUpRow | undefined;
    if (!found) throw new BrainDomainError("NOT_FOUND", "challenge not found");
    if (found.actor_id !== actor.actorId || found.auth_session_digest !== sessionDigest || found.factor_digest !== (humanSession!.factorDigest ?? null) || found.auth_generation !== actor.authGeneration) throw new BrainDomainError("FORBIDDEN", "challenge binding changed");
    if (found.expires_at_ms <= store.now() || found.revoked_at_ms !== null) throw new BrainDomainError("APPROVAL_EXPIRED", "step-up challenge expired");
    if (found.verified_at_ms !== null) throw new BrainDomainError("CONFLICT", "challenge already verified");
    if (found.attempts >= 5) throw new BrainDomainError("RATE_LIMITED", "step-up attempts exhausted");
    store.control.prepare("UPDATE command_step_ups SET attempts=attempts+1 WHERE id=?").run(challengeId);
    return found;
  });
  const credential = await resolveActor(store, auth, headers);
  if (credential.sessionDigest !== sessionDigest || credential.actor.actorId !== actor.actorId || credential.actor.organizationId !== actor.organizationId) throw new BrainDomainError("FORBIDDEN", "step-up credential binding mismatch");
  const method = auth.requireTwoFactor || code ? "totp" : "session";
  if (method === "totp" && !await auth.verifyTotp(headers, code)) throw new BrainDomainError("FORBIDDEN", "TOTP verification failed");
  return store.inTx(store.control, () => {
    assertHumanIdentity(store, auth, identity, auth.requireTwoFactor);
    const verified = store.control.prepare("UPDATE command_step_ups SET verified_at_ms=?,method=? WHERE id=? AND verified_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms>?").run(store.now(), method, challengeId, store.now());
    if (verified.changes !== 1) throw new BrainDomainError("CONFLICT", "challenge expired or already verified");
    return { evidenceId: challengeId, subjectDigest: row.subject_digest, expiresAt: iso(Math.min(row.expires_at_ms, store.now() + VALID_MS)), method };
  });
}

/**
 * Spends the evidence a command names, inside the command's own transaction. It must be this person's, from this session, for exactly this command,
 * workspace and payload, verified, unspent and still current; a replay of the same command is answered from its receipt before reaching here.
 */
export function spendCommandStepUp(store: Store, auth: BrainAuth, call: { actor: ActorContext; identity?: ResolvedActor | undefined }, input: { commandType: string; workspaceId: string; payload: JsonValue }): void {
  const evidenceId = (input.payload as Record<string, JsonValue>)["stepUpEvidenceId"];
  if (typeof evidenceId !== "string" || !evidenceId) throw new BrainDomainError("APPROVAL_REQUIRED", "a fresh step-up is required for this change");
  const identity = call.identity;
  if (!identity?.humanSession) throw new BrainDomainError("APPROVAL_REQUIRED", "a fresh step-up needs a signed-in person's session");
  const row = store.control.prepare("SELECT * FROM command_step_ups WHERE id=?").get(evidenceId) as StepUpRow | undefined;
  const { actor } = call;
  if (!row || row.command_type !== input.commandType || row.workspace_id !== input.workspaceId || row.subject_digest !== commandSubject(input.commandType, input.workspaceId, input.payload)
    || row.actor_id !== actor.actorId || row.auth_session_digest !== identity.sessionDigest || row.verified_at_ms === null || row.consumed_at_ms !== null || row.revoked_at_ms !== null
    || row.expires_at_ms <= store.now() || (auth.requireTwoFactor && row.method !== "totp") || row.auth_generation !== actor.authGeneration
    || !auth.isSessionCurrent(row.auth_user_id, row.auth_session_id, store.now(), row.factor_digest)) {
    throw new BrainDomainError("FORBIDDEN", "step-up evidence invalid, expired, or already used");
  }
  store.control.prepare("UPDATE command_step_ups SET consumed_at_ms=? WHERE id=?").run(store.now(), evidenceId);
}
