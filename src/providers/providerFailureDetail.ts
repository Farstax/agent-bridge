import { redactProviderApiKeySecrets } from "./apiKeyAuth.js";

const PROVIDER_FAILURE_CAUSE_DEPTH = 3;
const PROVIDER_FAILURE_DETAIL_MAX_CHARS = 1_200;
const STRUCTURED_DETAIL_FIELDS = ["message", "details", "additionalDetails"] as const;

type ErrorWithData = Error & {
  readonly cause?: unknown;
  readonly data?: unknown;
};

function normalizeError(error: unknown): ErrorWithData {
  return error instanceof Error ? error as ErrorWithData : new Error(String(error));
}

function uniquePush(parts: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || parts.includes(trimmed)) return;
  parts.push(trimmed);
}

export function isGenericProviderFailureMessage(message: string): boolean {
  const normalized = message.trim();
  return /^(?:(?:RequestError|Error|AcpError):\s*)?Internal error$/i.test(normalized)
    || /^(?:query stream error:\s*)?ACP connection closed$/i.test(normalized);
}

/** Structured provider-owned details retained across ACP wrappers and causes. */
export function collectProviderFailureDetails(error: unknown): string[] {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < PROVIDER_FAILURE_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const normalized = normalizeError(current);
    const data = normalized.data;
    if (data && typeof data === "object") {
      for (const field of STRUCTURED_DETAIL_FIELDS) {
        uniquePush(parts, (data as Record<string, unknown>)[field]);
      }
    }
    current = normalized.cause;
  }

  return parts;
}

/** First useful provider/cause detail for user presentation, excluding generic transport wrappers. */
export function actionableProviderFailureDetail(error: unknown): string | null {
  const structured = collectProviderFailureDetails(error)
    .find((detail) => !isGenericProviderFailureMessage(detail));
  if (structured) return structured;

  const seen = new Set<unknown>();
  let current: unknown = normalizeError(error).cause;
  for (let depth = 0; depth < PROVIDER_FAILURE_CAUSE_DEPTH - 1 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const normalized = normalizeError(current);
    if (normalized.message.trim() && !isGenericProviderFailureMessage(normalized.message)) {
      return normalized.message.trim();
    }
    current = normalized.cause;
  }
  return null;
}

/** Bounded, redacted technical diagnostic retaining wrapper, structured detail, and cause chain. */
export function boundedProviderFailureDiagnostic(
  error: unknown,
  env: NodeJS.ProcessEnv,
  fallback: string,
): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < PROVIDER_FAILURE_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const normalized = normalizeError(current);
    uniquePush(parts, `${normalized.name}: ${normalized.message}`);
    const structured = collectProviderFailureDetails(normalized);
    for (const detail of structured) {
      if (!parts.some((part) => part.includes(detail))) uniquePush(parts, `provider: ${detail}`);
    }
    current = normalized.cause;
  }

  const bounded = (parts.join("\ncaused by: ") || fallback).slice(0, PROVIDER_FAILURE_DETAIL_MAX_CHARS);
  return redactProviderApiKeySecrets(bounded, env);
}

export function sanitizeProviderFailureText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return redactProviderApiKeySecrets(text.trim().slice(0, PROVIDER_FAILURE_DETAIL_MAX_CHARS), env);
}
