export type ErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "ambiguous"
  | "project_not_allowed"
  | "rate_limited"
  | "upstream_error"
  | "invalid_input"
  | "approval_denied"
  | "export_too_large"
  | "export_failed";

const MESSAGES: Record<ErrorCode, string> = {
  auth_failed: "PAT rejected or expired",
  forbidden: "PAT lacks the scope for this call",
  not_found: "Not found",
  ambiguous: "Several matches",
  project_not_allowed: "Project not in allowlist",
  rate_limited: "Rate limited, try later",
  upstream_error: "Azure DevOps error",
  invalid_input: "Invalid input",
  approval_denied: "Approval denied, nothing was changed",
  export_too_large: "Result too large to export",
  export_failed: "Could not write the export file",
};

/**
 * Error with a fixed, safe message. Never carries headers, tokens or bodies.
 * `details` holds non-secret numbers only (for example fullSize).
 */
export class AzdoError extends Error {
  constructor(
    public readonly code: ErrorCode,
    detail?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
  }
}
