import type { Accessor, JSX } from "solid-js";
import { createContext, createMemo, createSignal, onMount, useContext } from "solid-js";
import { createScopedRead } from "../data/screens";
import type { ScreenState } from "../data/screens";
import { governor, GovernorError } from "../data/client";
import { identity as fetchIdentity, membersQuery } from "../data/governor";
import type { CommandKind, PayloadFor } from "../data/commands";
import { send } from "../data/commands";
import type { IdentityView, MemberGrantView, SetupStatus } from "@brain/contracts";
import type { ApprovalIntent, ApprovalOutcome } from "./approval-controller";

/**
 * The one session/authority context (document 21).
 *
 * It owns the verified identity, the selected workspace and the authorization
 * generation that scopes every read. A workspace switch, sign-out or a revoked
 * session bumps the generation, which aborts in-flight reads and clears cached
 * protected content through `createScopedRead` — no screen can keep another
 * scope's rows.
 */
export interface AppContextValue {
  readonly ready: Accessor<boolean>;
  readonly setupRequired: Accessor<boolean>;
  readonly identity: Accessor<IdentityView | null>;
  readonly globalError: Accessor<string>;
  readonly workspaceId: Accessor<string>;
  readonly workspaceOptions: Accessor<{ value: string; label: string; description?: string }[]>;
  /** Read-model scope: changes abort in-flight reads and drop cached bodies. */
  readonly scope: Accessor<{ organizationId: string; workspaceId: string; generation: number }>;
  readonly myRoles: Accessor<string[]>;
  readonly canDispatch: Accessor<boolean>;
  readonly canOperate: Accessor<boolean>;
  readonly canAdminister: Accessor<boolean>;
  readonly canApprove: Accessor<boolean>;
  readonly canPublish: Accessor<boolean>;
  selectWorkspace: (workspaceId: string) => void;
  start: () => Promise<void>;
  reloadIdentity: () => Promise<void>;
  signOut: () => Promise<void>;
  /** One authoritative command bound to the current workspace and actor. */
  run: <K extends CommandKind>(
    commandType: K,
    payload: PayloadFor<K>,
    options?: { expectedVersion?: number; idempotencyKey?: string; commandId?: string },
  ) => Promise<{ accepted: boolean; outcome: string; detail: string; resourceId?: string }>;
  verifyIdentity: (approvalId: string, subjectDigest: string, code: string) => Promise<string>;
  submitDecision: (intent: ApprovalIntent, stepUpEvidenceId: string) => Promise<ApprovalOutcome>;
  checkDecision: (intent: { approvalId: string; idempotencyKey: string }) => Promise<"confirmed" | "pending">;
  /** Members read used for role gating; also the authority for can* flags. */
  useMembers: () => { state: Accessor<ScreenState<MemberGrantView[]>>; refresh: (options?: { force?: boolean }) => Promise<void> };
}

const AppContext = createContext<AppContextValue>();

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function AppProvider(props: { children: JSX.Element }): JSX.Element {
  const [ready, setReady] = createSignal(false);
  const [setupRequired, setSetupRequired] = createSignal(false);
  const [identity, setIdentity] = createSignal<IdentityView | null>(null);
  const [globalError, setGlobalError] = createSignal("");
  const [workspaceId, setWorkspaceId] = createSignal("");
  // The authorization generation: bumped on every scope/identity change so no
  // cached read can survive a revocation (document 21 cache identity). It starts
  // at 1 — `createScopedRead` treats 0 as "no scope resolved yet".
  const [generation, setGeneration] = createSignal(1);

  function scope() {
    return {
      organizationId: identity()?.actor.organizationId ?? "",
      workspaceId: workspaceId(),
      generation: generation(),
    };
  }

  // Role gating needs this workspace's member grants. One scoped read, shared.
  const members = createScopedRead<MemberGrantView[]>({
    scope,
    load: async (scopeValue, signal) => {
      const loaded = await membersQuery(scopeValue.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    refreshMs: 30_000,
  });

  const myMemberships = createMemo(() => members.state().data ?? []);
  const myRoles = () => {
    const me = identity();
    if (!me || me.actor.kind !== "human") return [];
    return myMemberships()
      .find((m) => m.principalId === me.actor.actorId && !m.revoked)
      ?.roles.map(String) ?? [];
  };
  const hasRole = (role: string) => myRoles().includes(role) || myRoles().includes("workspace-lead");

  async function reloadIdentity() {
    setGeneration((g) => g + 1);
    const current = generation();
    const next = await fetchIdentity();
    if (current !== generation()) return;
    setIdentity(next);
    const readable = next.workspaces.some((w) => w.workspaceId === workspaceId());
    if (!readable) setWorkspaceId(next.workspaces[0]?.workspaceId ?? "");
    setSetupRequired(false);
  }

  async function start() {
    setReady(false);
    setGlobalError("");
    try {
      const status = await governor<SetupStatus>("/v1/setup/status");
      setSetupRequired(status.setupRequired);
      if (status.initialized) {
        try { await reloadIdentity(); }
        catch (e) {
          if (!(e instanceof GovernorError && (e.status === 401 || e.status === 403))) throw e;
          setIdentity(null);
        }
      }
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : "Governor is unavailable.");
    } finally { setReady(true); }
  }

  function selectWorkspace(next: string) {
    if (next === workspaceId()) return;
    // Scope change: the generation bump clears every scoped read's cache.
    setGeneration((g) => g + 1);
    setWorkspaceId(next);
  }

  async function signOut() {
    setGeneration((g) => g + 1);
    setIdentity(null);
    setWorkspaceId("");
    try { await governor("/api/auth/sign-out", {}); setGlobalError(""); }
    catch { setGlobalError("Sign-out could not be confirmed. Retry when Governor is available."); }
  }

  async function run<K extends CommandKind>(
    commandType: K,
    payload: PayloadFor<K>,
    options?: { expectedVersion?: number; idempotencyKey?: string; commandId?: string },
  ) {
    const receipt = await send(commandType, payload, {
      workspaceId: workspaceId(),
      idempotencyKey: options?.idempotencyKey,
      commandId: options?.commandId,
      expectedVersion: options?.expectedVersion,
    });
    return {
      accepted: receipt.accepted,
      outcome: receipt.outcome,
      detail: receipt.accepted
        ? receipt.outcome === "pending-approval" ? "Recorded — this effect needs an approval before it runs."
          : receipt.outcome === "applied" ? "Applied." : "Queued for execution."
        : (receipt as { error?: { detail: string } }).error?.detail ?? "the Governor refused this request",
      resourceId: receipt.resourceId,
    };
  }

  async function verifyIdentity(approvalId: string, subjectDigest: string, code: string): Promise<string> {
    const challenge = await governor<{ challengeId: string }>("/v1/step-up/challenges", { approvalId, subjectDigest });
    const evidence = await governor<{ evidenceId: string }>("/v1/step-up/verify", { challengeId: challenge.challengeId, code });
    return evidence.evidenceId;
  }

  async function submitDecision(intent: ApprovalIntent, stepUpEvidenceId: string): Promise<ApprovalOutcome> {
    try {
      await governor(`/v1/approvals/${intent.approvalId}/decision`, {
        contractVersion: "brain.approval-decision/v1", idempotencyKey: intent.idempotencyKey, decision: intent.decision ?? "approve",
        subjectDigest: intent.subjectDigest, expectedVersion: intent.expectedVersion, note: intent.note, ...(stepUpEvidenceId ? { stepUpEvidenceId } : {}),
      });
      return "confirmed";
    } catch (e) {
      if (e instanceof GovernorError && e.status === 409) return "stale";
      if (e instanceof GovernorError && (e.status === 401 || e.status === 403)) return "denied";
      return "pending";
    }
  }

  async function checkDecision(intent: { approvalId: string; idempotencyKey: string }): Promise<"confirmed" | "pending"> {
    try {
      const result = await governor<{ status: string }>(`/v1/approvals/${intent.approvalId}/decision-status`, { idempotencyKey: intent.idempotencyKey });
      return result.status === "confirmed" ? "confirmed" : "pending";
    } catch { return "pending"; }
  }

  const value: AppContextValue = {
    ready, setupRequired, identity, globalError,
    workspaceId,
    workspaceOptions: () => (identity()?.workspaces ?? []).map((w) => ({ value: w.workspaceId, label: w.name, description: w.status })),
    scope,
    myRoles, canDispatch: () => identity()?.actor.kind === "human" && hasRole("operator"),
    canOperate: () => identity()?.actor.kind === "human" && hasRole("operator"),
    canAdminister: () => identity()?.actor.kind === "human" && (myRoles().includes("workspace-lead") || Boolean(identity()?.actor.scopes.includes("config:activate"))),
    canApprove: () => identity()?.actor.kind === "human" && hasRole("approver"),
    canPublish: () => identity()?.actor.kind === "human" && hasRole("operator"),
    selectWorkspace, start, reloadIdentity, signOut, run,
    verifyIdentity, submitDecision, checkDecision,
    useMembers: () => ({ state: members.state, refresh: members.refresh }),
  };

  onMount(() => { void start(); });

  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>;
}
