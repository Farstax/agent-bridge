import { PROVIDER_IDS, type ProviderErrorClassification, type ProviderId } from "./types.js";

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
  ],
  cursor: [
    /No capacity available/i,
    /RESOURCE_EXHAUSTED/,
    /quota (?:reached|exceeded)/i,
    /hit your (?:session |usage )?limit/i,
    /usage limit/i,
    /rate limit/i,
  ],
};

const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication required/i,
  /auth required/i,
  /login required/i,
  /please log in/i,
  /invalid api key/i,
  /unauthorized/i,
  /permission denied/i,
  /XAI_API_KEY/i,
  /grok login/i,
  /CURSOR_API_KEY/i,
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

export function classifyProviderError(providerId: ProviderId, error: Error | string): ProviderErrorClassification {
  const message = typeof error === "string" ? error : error.message;

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
