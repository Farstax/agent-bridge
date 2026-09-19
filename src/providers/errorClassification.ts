import { PROVIDER_IDS, type ProviderErrorClassification, type ProviderId } from "./types.js";

export const CLAUDE_OAUTH_REFRESH_CONTENTION_MARKER =
  "another Claude Code process is refreshing it or exited mid-refresh";
const CLAUDE_OAUTH_REFRESH_CONTENTION_PATTERN = /another Claude Code process is refreshing it or exited mid-refresh/i;

const CAPACITY_PATTERNS: Readonly<Record<ProviderId, readonly RegExp[]>> = {
  codex: [
    /MODEL_CAPACITY_EXHAUSTED/,
    /No capacity available/i,
    /rateLimitExceeded/,
    /RESOURCE_EXHAUSTED/,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /session limit/i,
    /usage limit/i,
    /\bresets\b/i,
    /api_error_status"?:\s*429/i,
  ],
  claude: [
    /overloaded_error/i,
    /\bOverloaded\b/,
    /api_error_status"?:\s*429/i,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /usage limit/i,
    /rate limit/i,
  ],
  agy: [
    /No capacity available/i,
    /RESOURCE_EXHAUSTED/,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /session limit/i,
    /usage limit/i,
    /\bresets\b/i,
  ],
  grok: [
    /No capacity available/i,
    /RESOURCE_EXHAUSTED/,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /usage limit/i,
    /rate limit/i,
    /\b402\b.*Payment Required/i,
    /usage balance exhausted/i,
  ],
  cursor: [
    /No capacity available/i,
    /RESOURCE_EXHAUSTED/,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /usage limit/i,
    /rate limit/i,
    /Upgrade your plan to continue/i,
  ],
  "custom-acp": [],
};

const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication required/i,
  /auth required/i,
  /login required/i,
  /please log in/i,
  /invalid api key/i,
  /failed to authenticate/i,
  /unauthorized/i,
  /permission denied/i,
  /XAI_API_KEY/i,
  /grok login/i,
  /cursor-agent login/i,
  /agent login first/i,
];

const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /model\s+"?[\w./:-]+"?\s+(?:not found|does not exist)/i,
  /Cannot use this model:/i,
  /unknown model\s+[\w./:-]+/i,
  /unsupported model\s+[\w./:-]+/i,
  // claude CLI json mode reports an unknown/unauthorized model as a 404 with
  // "There's an issue with the selected model (...). It may not exist or you may not have access to it."
  /issue with the selected model/i,
];

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  CLAUDE_OAUTH_REFRESH_CONTENTION_PATTERN,
  /ECONNRESET|ECONNREFUSED|EPIPE/i,
  /socket hang up/i,
  /temporar(?:y|ily)/i,
  /transient/i,
  /service unavailable/i,
];

const FATAL_PATTERNS: readonly RegExp[] = [
  /command not found/i,
  /ENOENT/i,
  /not a git repository/i,
];

function matchReason(message: string, patterns: readonly RegExp[]): string | null {
  return patterns.find(pattern => pattern.test(message))?.source ?? null;
}

/**
 * Include a structured provider message when present so exact provider-owned
 * retry conditions can be recognized even if the ACP transport wraps them in
 * a generic top-level RequestError such as "Internal error".
 */
function errorMessage(error: Error | string): string {
  if (typeof error === "string") return error;
  const data = (error as { data?: unknown }).data;
  const nested = data && typeof data === "object"
    ? (data as { message?: unknown }).message
    : undefined;
  return [error.message, typeof nested === "string" ? nested : null]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/** Provider-owned OAuth refresh remains in Claude; Bridge only recognizes this exact retryable contention shape. */
export function isClaudeOAuthRefreshContention(error: Error | string): boolean {
  return errorMessage(error).toLowerCase().includes(CLAUDE_OAUTH_REFRESH_CONTENTION_MARKER.toLowerCase());
}

interface AcpStructuredErrorData {
  readonly message?: string;
  readonly codexErrorInfo?: string | Readonly<Record<string, unknown>>;
  readonly additionalDetails?: string;
}

function acpErrorData(error: Error | string): AcpStructuredErrorData | null {
  if (typeof error === "string") return null;
  const data = (error as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as AcpStructuredErrorData) : null;
}

const ACP_CODEX_ERROR_INFO_KIND: Readonly<Record<string, ProviderErrorClassification["kind"]>> = {
  usageLimitExceeded: "capacity_exhausted",
  rateLimitExceeded: "capacity_exhausted",
  serverOverloaded: "capacity_exhausted",
  unauthorized: "auth_required",
};

const ACP_CODEX_STRUCTURED_ERROR_INFO_KIND: Readonly<Record<string, ProviderErrorClassification["kind"]>> = {
  httpConnectionFailed: "transient",
  responseStreamConnectionFailed: "transient",
  responseStreamDisconnected: "transient",
  responseTooManyFailedAttempts: "transient",
};

function classifyAcpCodexErrorInfo(data: AcpStructuredErrorData): ProviderErrorClassification | null {
  const info = data.codexErrorInfo;
  if (info == null) return null;
  if (typeof info === "string") {
    return { kind: ACP_CODEX_ERROR_INFO_KIND[info] ?? "unknown", reason: `acp:codexErrorInfo:${info}` };
  }
  const key = Object.keys(info)[0];
  if (!key) return { kind: "unknown", reason: "acp:codexErrorInfo:structured" };
  return { kind: ACP_CODEX_STRUCTURED_ERROR_INFO_KIND[key] ?? "unknown", reason: `acp:codexErrorInfo:${key}` };
}

export function classifyProviderError(providerId: ProviderId, error: Error | string): ProviderErrorClassification {
  const data = acpErrorData(error);
  if (data?.codexErrorInfo !== undefined) {
    const structured = classifyAcpCodexErrorInfo(data);
    if (structured) return structured;
  }
  if (providerId === "claude" && isClaudeOAuthRefreshContention(error)) {
    // The retry owner handles the first occurrence before classification reaches
    // routing. If contention survives that bounded retry, the shared credential
    // store is not currently usable and must follow the existing auth-required
    // availability path rather than remain selectable as a transient failure.
    return { kind: "auth_required", reason: CLAUDE_OAUTH_REFRESH_CONTENTION_PATTERN.source };
  }
  const message = data
    ? [typeof error === "string" ? error : error.message, data.message, data.additionalDetails]
      .filter((part): part is string => Boolean(part))
      .join("\n")
    : typeof error === "string" ? error : error.message;

  const authReason = matchReason(message, AUTH_PATTERNS);
  if (authReason) return { kind: "auth_required", reason: authReason };

  const capacityReason = matchReason(message, CAPACITY_PATTERNS[providerId]);
  if (capacityReason) return { kind: "capacity_exhausted", reason: capacityReason };

  const modelReason = matchReason(message, MODEL_UNAVAILABLE_PATTERNS);
  if (modelReason) return { kind: "model_unavailable", reason: modelReason };

  const transientReason = matchReason(message, TRANSIENT_PATTERNS);
  if (transientReason) return { kind: "transient", reason: transientReason };

  const fatalReason = matchReason(message, FATAL_PATTERNS);
  if (fatalReason) return { kind: "fatal", reason: fatalReason };

  return { kind: "unknown", reason: "no provider error pattern matched" };
}

export function classifyAnyProviderError(error: Error | string): ProviderErrorClassification {
  for (const providerId of PROVIDER_IDS) {
    const classification = classifyProviderError(providerId, error);
    if (classification.kind !== "unknown") return classification;
  }
  return { kind: "unknown", reason: "no provider error pattern matched" };
}

export function isFallbackEligibleProviderError(classification: ProviderErrorClassification): boolean {
  return classification.kind === "capacity_exhausted" || classification.kind === "model_unavailable";
}

export function isRetryEligibleProviderError(
  providerId: ProviderId,
  error: Error | string,
  attempt = 1,
): boolean {
  return attempt === 1 && providerId === "claude" && isClaudeOAuthRefreshContention(error);
}
