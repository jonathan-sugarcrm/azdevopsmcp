export type ErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "ambiguous"
  | "project_not_allowed"
  | "rate_limited"
  | "upstream_error"
  | "invalid_input"
  | "approval_denied";

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
};

/** Error with a fixed, safe message. Never carries headers, tokens or bodies. */
export class AzdoError extends Error {
  constructor(
    public readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code]);
  }
}
