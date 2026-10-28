import type { BrainError, ErrorCode } from "@brain/contracts";

export class BrainDomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly fields?: Readonly<Record<string, string>>;
  constructor(code: ErrorCode, detail: string, opts?: { retryable?: boolean; fields?: Record<string, string> }) {
    super(detail);
    this.name = "BrainDomainError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.fields) this.fields = opts.fields;
  }
  toBrainError(correlationId: string): BrainError {
    const base: BrainError = { code: this.code, detail: this.message, retryable: this.retryable, correlationId, ...(this.fields ? { fields: this.fields } : {}) };
    return base;
  }
}

export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED": return 401;
    case "FORBIDDEN": case "POLICY_DENIED": case "APPROVAL_EXPIRED": case "APPROVAL_REVOKED": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": case "STALE_VERSION": case "IDEMPOTENCY_CONFLICT": return 409;
    case "CURSOR_EXPIRED": return 410;
    case "PAYLOAD_TOO_LARGE": return 413;
    case "INVALID_CONTRACT": case "INVALID_ARGUMENT": case "UNSUPPORTED_CAPABILITY": case "UNSUPPORTED_PROTOCOL": case "EVIDENCE_MISSING": case "APPROVAL_REQUIRED": return 422;
    case "RATE_LIMITED": case "CAPACITY_EXCEEDED": return 429;
    case "DEPENDENCY_UNAVAILABLE": case "LEASE_LOST": return 503;
    case "OUTCOME_UNKNOWN": return 409;
    case "BUDGET_EXHAUSTED": return 429;
    case "UPGRADE_REQUIRED": return 426;
    default: return 500;
  }
}

export function brainError(code: ErrorCode, detail: string, correlationId: string, retryable = false): BrainError {
  return { code, detail, retryable, correlationId };
}
