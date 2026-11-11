import type { CheckResult, TrustRead, VerificationVerdict } from "@brain/contracts";
import type { Store } from "../../application/store";
import { pinnedEvaluator } from "./service";

type Db = ReturnType<Store["workspaceDb"]>;

export interface TrustInput {
  readonly checks: readonly CheckResult[];
  /** What the evaluator is made of: a deterministic tool (files, tests, hashes) or a model's judgement. */
  readonly evaluatorBasis: "deterministic" | "model-opinion";
  readonly independence: "L1" | "L2" | "L3";
  /** The person who signed off criteria that rest on model opinion alone, when one did. */
  readonly signedOffBy?: string;
}

/**
 * The deterministic trust read over one stored verdict (#49). Per criterion the
 * check basis is: a passed check of a deterministic evaluator is a deterministic
 * oracle; a passed check of a model-backed evaluator is model opinion, which is
 * Unverified until a person signs off, and then counts as human sign-off; any
 * check that did not pass supports nothing. The done gate and every screen call
 * this one function, so what is shown and what is allowed cannot disagree.
 */
export function deriveTrust(input: TrustInput): TrustRead {
  const rows = input.checks.map((check) => {
    const passed = check.status === "passed";
    const basis: TrustRead["rows"][number]["basis"] = !passed ? "none" : input.evaluatorBasis === "deterministic" ? "deterministic" : input.signedOffBy ? "human" : "model";
    return { criterionId: check.criterionId, checkId: check.checkId, status: check.status, basis, independence: input.independence };
  });
  const count = (basis: TrustRead["rows"][number]["basis"]) => rows.filter((row) => row.basis === basis).length;
  const deterministic = count("deterministic");
  const human = count("human");
  const model = count("model");
  const unverified = rows.filter((row) => row.basis === "model" || row.basis === "none").map((row) => row.criterionId);
  const unmet = rows.filter((row) => row.basis === "none").length;
  const plural = (n: number) => `${n} ${n === 1 ? "criterion" : "criteria"}`;
  const sentence = `${deterministic} of ${plural(rows.length)} checked by tests, files or hashes; ${human} by human sign-off; ${model} by model opinion`;
  const tail = model > 0 ? `. A model's opinion alone does not make this Done: a person must sign off`
    : unmet > 0 ? `. ${unmet} not met` : "";
  return { rows, total: rows.length, deterministic, human, model, unverified, ...(input.signedOffBy ? { signedOffBy: input.signedOffBy } : {}), text: `${sentence}${tail}.` };
}

/** True when Done needs a person: some passed criterion is supported by model opinion only. */
export function needsSignOff(trust: TrustRead): boolean {
  return trust.model > 0;
}

/**
 * The trust read of one evidence bundle's stored verdict: the evaluator's basis
 * from the release the run was pinned to, and the sign-off from the Done
 * transition a person recorded on the evidence. Undefined while no verdict exists.
 */
export function trustForBundle(store: Store, organizationId: string, db: Db, bundleDigest: string): TrustRead | undefined {
  const verdictRow = db.prepare("SELECT manifest_json FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms LIMIT 1").get(bundleDigest) as { manifest_json: string } | undefined;
  const bundleRow = db.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=?").get(bundleDigest) as { manifest_json: string } | undefined;
  if (!verdictRow || !bundleRow) return undefined;
  const verdict = JSON.parse(verdictRow.manifest_json) as VerificationVerdict;
  const configDigest = (JSON.parse(bundleRow.manifest_json) as { configDigest: string }).configDigest;
  let evaluatorBasis: TrustInput["evaluatorBasis"] = "deterministic";
  // The verdict was only accepted because the run's release pinned this evaluator, so an unresolvable pin can only mean a row without a release behind it.
  try { evaluatorBasis = pinnedEvaluator(store, organizationId, configDigest, verdict.evaluatorRelease).spec.basis ?? "deterministic"; } catch { evaluatorBasis = "deterministic"; }
  const signed = db.prepare(`SELECT json_extract(payload_json,'$.signedOffBy') AS by FROM events WHERE event_type='workItem.transitioned'
    AND json_extract(payload_json,'$.state')='done' AND json_extract(payload_json,'$.evidenceDigest')=? AND json_extract(payload_json,'$.signedOffBy') IS NOT NULL ORDER BY cursor DESC LIMIT 1`).get(bundleDigest) as { by: string } | undefined;
  return deriveTrust({ checks: verdict.checks ?? [], evaluatorBasis, independence: verdict.independence, ...(signed ? { signedOffBy: signed.by } : {}) });
}

