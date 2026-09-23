/**
 * Structured error semantics (protocol sections 12, 19).
 */
export const ERROR_CODES = [
  "SCHEMA_INVALID",
  "VERSION_UNSUPPORTED",
  "CROSS_PROJECT_REFERENCE",
  "IDEMPOTENCY_MISMATCH",
  "STALE_REVISION",
  "SPECIFICATION_UNSUPPORTED",
  "UNRESOLVED_TARGET",
  "AMBIGUOUS_TARGET",
  "CAPABILITY_MISSING",
  "COMPATIBILITY_ERROR",
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "BUDGET_EXCEEDED",
  "LOCKED_REGION",
  "JOB_LEASE_LOST",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class UiIntelligenceError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; httpStatus?: number }) {
    super(`[${code}] ${message}`);
    this.name = "UiIntelligenceError";
    this.code = code;
    this.details = options?.details;
    this.httpStatus = options?.httpStatus ?? defaultHttpStatus(code);
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case "SCHEMA_INVALID":
    case "SPECIFICATION_UNSUPPORTED":
      return 422;
    case "STALE_REVISION":
      return 409;
    case "IDEMPOTENCY_MISMATCH":
      return 409;
    case "UNRESOLVED_TARGET":
    case "AMBIGUOUS_TARGET":
      return 422;
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "UNAUTHORIZED":
      return 401;
    case "BUDGET_EXCEEDED":
      return 429;
    default:
      return 400;
  }
}

export type ErrorResponse = {
  error: { code: ErrorCode; message: string; details?: unknown };
  traceId: string;
};
