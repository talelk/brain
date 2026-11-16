import type { ActionSubject, ApprovalRisk, AutonomyPolicy } from "@brain/contracts";
import type { Store } from "../../application/store";
import { activeReleaseRecord, isProductionEnvironment, policyForRelease, policyOf } from "../configuration/index";
import { declaredTool, type ReleaseTools } from "./context";

/**
 * The risk tier of one effect request (ADR 0075): a small ordered scale computed from facts the Governor already holds, by code and not by
 * a model. The tier and what it requires are stamped on the approval's subject when it is requested, so the digest binds them. A tier only
 * ever asks MORE of the approval (a TOTP step-up, a second different approver); it never skips, shares or pre-approves an effect, which
 * keeps its own approval and permit (ADR 0024).
 */
export type RiskTier = ApprovalRisk["tier"];
export const RISK_TIERS: readonly RiskTier[] = ["low", "elevated", "high", "critical"];
export function tierRank(tier: RiskTier): number { return RISK_TIERS.indexOf(tier); }

/** Where each tier starts on the score below. */
const ELEVATED_FROM = 4;
const HIGH_FROM = 6;
const CRITICAL_FROM = 7;

/** Paths a change should not touch unannounced: outside the working tree, or the places that hold credentials and pipelines. */
const SENSITIVE_PATH = /(^|\/)(\.github|\.gitlab|\.circleci|\.ssh|\.aws|\.gnupg|secrets?)(\/|$)|(^|\/)\.env([./]|$)|(^|\/)id_(rsa|ed25519)|\.pem$|\.key$/iu;

interface Factor { readonly points: number; readonly code: string; readonly fact: string }

function filePaths(subject: ActionSubject): string[] {
  const args = subject.effectBounds?.["arguments"];
  const files = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>)["files"] : undefined;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => (file !== null && typeof file === "object" && typeof (file as Record<string, unknown>)["path"] === "string" ? [String((file as Record<string, unknown>)["path"])] : []));
}

function outsideTarget(path: string): boolean { return path.startsWith("/") || path.split("/").includes("..") || SENSITIVE_PATH.test(path); }

/** The organization and workspace an approval belongs to: a workflow gate's proposal need not name them, the Governor knows them. */
export interface Scope { readonly organizationId: string; readonly workspaceId: string }

/** The preset of the mission the call serves, when it serves one. */
export function missionPreset(s: Store, subject: ActionSubject, scope: Scope): AutonomyPolicy["preset"] | undefined {
  if (!subject.origin?.missionId) return undefined;
  const row = s.workspaceDb(scope.workspaceId, scope.organizationId).prepare("SELECT policy_json FROM missions WHERE id=?").get(subject.origin.missionId) as { policy_json: string } | undefined;
  return row ? (JSON.parse(row.policy_json) as AutonomyPolicy).preset : undefined;
}

/** The person who owns the mission an approval serves: at the critical tier they may not decide it. */
export function missionOwner(s: Store, subject: ActionSubject, scope: Scope): string | undefined {
  if (!subject.origin?.missionId) return undefined;
  return (s.workspaceDb(scope.workspaceId, scope.organizationId).prepare("SELECT owner_id FROM missions WHERE id=?").get(subject.origin.missionId) as { owner_id: string } | undefined)?.owner_id;
}

/** The release policy may only raise the tier: a production change under productionHumanApproval is at least high, whatever its score. */
function policyFloor(s: Store, subject: ActionSubject, scope: Scope): { tier: RiskTier; fact: string } | undefined {
  const policies = [policyForRelease(s, scope.organizationId, subject.configDigest), policyOf(activeReleaseRecord(s, scope.organizationId)?.release)];
  for (const policy of policies) {
    if (policy?.effective.productionHumanApproval === "required" && isProductionEnvironment(subject.target?.environmentId ?? "")) {
      const layer = policy.provenance["productionHumanApproval"] ?? policy.layers[0] ?? "policy";
      return { tier: "high", fact: `Policy ${layer} requires a person to approve a change to production (productionHumanApproval)` };
    }
  }
  return undefined;
}

/** The risk of this request, from its subject and the Governor's own records. Deterministic: the same facts give the same tier and reasons. */
export function assessRisk(s: Store, subject: ActionSubject, scope: Scope, releases: Map<string, ReleaseTools> = new Map()): ApprovalRisk {
  // A workflow gate's proposal may name little more than an operation: whatever is missing counts for nothing, never as an error.
  const toolId = subject.tool?.id ?? subject.operation ?? "effect";
  const declared = subject.tool && subject.configDigest ? declaredTool(s, scope.organizationId, subject, releases) : undefined;
  const effectClass = declared?.effectClass ?? "write";
  const factors: Factor[] = [];
  if (effectClass === "privileged") factors.push({ points: 3, code: "class-privileged", fact: `${toolId} is a privileged effect` });
  else if (effectClass === "write") factors.push({ points: 1, code: "class-write", fact: declared ? `${toolId} changes something outside Brain` : `${toolId} is not declared by its release, so it is treated as a write` });
  const environment = subject.target?.environmentId ?? "";
  if (isProductionEnvironment(environment)) factors.push({ points: 2, code: "production-environment", fact: `It targets the ${environment} environment` });
  const kind = toolId.split(".")[0] ?? "";
  if (kind === "git") factors.push({ points: 1, code: "repository", fact: "It changes a source repository" });
  else if (kind === "ticket") factors.push({ points: 1, code: "ticket-system", fact: "It changes a ticket system" });
  else if (kind === "host") factors.push({ points: 1, code: "host", fact: "It acts on a host" });
  else if (kind === "mcp" || (subject.target?.targetId ?? "").startsWith("mcp:")) factors.push({ points: 1, code: "external-tool", fact: "It calls an external tool" });
  const outside = filePaths(subject).filter(outsideTarget);
  if (outside.length > 0) factors.push({ points: 2, code: "files-outside-target", fact: `It touches ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""}, outside the declared target or in credential or pipeline files` });
  if (effectClass !== "read" && !declared?.compensatingAction) factors.push({ points: 1, code: "no-rollback", fact: "Its Tool document declares no rollback" });
  const preset = missionPreset(s, subject, scope);
  if (preset === "autonomous") factors.push({ points: 1, code: "autonomous-mission", fact: "Its mission runs on the autonomous preset, with no person confirming plan changes" });
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  let tier: RiskTier = score >= CRITICAL_FROM ? "critical" : score >= HIGH_FROM ? "high" : score >= ELEVATED_FROM ? "elevated" : "low";
  const reasons = factors.map(({ code, fact }) => ({ code, fact }));
  const floor = policyFloor(s, subject, scope);
  if (floor && tierRank(floor.tier) > tierRank(tier)) { tier = floor.tier; reasons.push({ code: "policy-floor", fact: floor.fact }); }
  return { tier, reasons, requires: requirementsOf(tier) };
}

/** What a tier asks of the approval: a TOTP step-up from elevated, and a second different approver at critical. */
export function requirementsOf(tier: RiskTier): ApprovalRisk["requires"] {
  return { stepUp: tierRank(tier) >= tierRank("elevated"), secondApprover: tier === "critical" };
}

/** The subject with its risk stamped by the Governor, whatever the proposal said: a caller cannot name a lower tier. */
export function withRisk<T extends ActionSubject>(s: Store, subject: T, scope: Scope, releases?: Map<string, ReleaseTools>): T {
  const { risk: _proposed, ...rest } = subject;
  return { ...rest, risk: assessRisk(s, rest as ActionSubject, scope, releases) } as T;
}

/** The distinct people who have approved this request so far (a critical request stays pending until a second, different one does). */
export function approversSoFar(s: Store, approvalId: string): string[] {
  return (s.control.prepare("SELECT DISTINCT actor_id FROM approval_decisions WHERE approval_id=? AND decision='approve'").all(approvalId) as Array<{ actor_id: string }>).map((row) => row.actor_id);
}

/**
 * What the bound risk asks of this approver that the rules for every approval do not: a request whose tier has since risen is refused (it
 * needs a new approval under its new tier), and a critical one is decided by two different people, neither the requester nor the
 * mission owner. The step-up half is checked where its evidence is read.
 */
export function riskProblem(s: Store, subject: ActionSubject, scope: Scope, bound: ApprovalRisk, who: { actorId: string; requestedBy: string; prior: readonly string[] }): { code: "CONFLICT" | "FORBIDDEN"; message: string } | undefined {
  const now = assessRisk(s, subject, scope);
  if (tierRank(now.tier) > tierRank(bound.tier)) return { code: "CONFLICT", message: `risk tier rose from ${bound.tier} to ${now.tier} since this approval was requested; a new approval under the ${now.tier} tier is needed` };
  if (!bound.requires.secondApprover) return undefined;
  if (who.actorId === who.requestedBy) return { code: "FORBIDDEN", message: "critical risk: the requester cannot approve; two different people must approve" };
  if (who.actorId === missionOwner(s, subject, scope)) return { code: "FORBIDDEN", message: "critical risk: the owner of the mission may not approve; two other people must approve" };
  if (who.prior.includes(who.actorId)) return { code: "FORBIDDEN", message: "critical risk: you already approved this; a second, different person must approve" };
  return undefined;
}
