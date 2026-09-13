import type { CliOptions } from "../types.js";
import { type as bridgeEventType, type BotKind, type RunDiagnosticEvent } from "../events/types.js";
import { redactProviderApiKeySecrets } from "./apiKeyAuth.js";
import {
  classifyProviderError,
  isFallbackEligibleProviderError,
  isRetryEligibleProviderError,
} from "./errorClassification.js";
import type { ProviderId } from "./types.js";

const ACP_FAILURE_DIAGNOSTIC_MAX_CHARS = 1_200;
const ACP_FAILURE_CAUSE_DEPTH = 3;
const diagnosedAcpFailures = new WeakSet<object>();

type ErrorWithData = Error & {
  readonly cause?: unknown;
  readonly data?: unknown;
};

function normalizeError(error: unknown): ErrorWithData {
  return error instanceof Error ? error as ErrorWithData : new Error(String(error));
}

export function hasAcpFailureDiagnostic(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && diagnosedAcpFailures.has(error as object));
}

function botKindForProvider(providerId: ProviderId): BotKind {
  return providerId === "agy" ? "antigravity" : providerId;
}

function structuredProviderMessage(error: ErrorWithData): string | null {
  const data = error.data;
  if (!data || typeof data !== "object") return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function boundedDiagnosticMessage(error: ErrorWithData, env: NodeJS.ProcessEnv): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < ACP_FAILURE_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const normalized = normalizeError(current);
    const label = `${normalized.name}: ${normalized.message}`.trim();
    if (label) parts.push(label);
    const structured = structuredProviderMessage(normalized);
    if (structured && !label.includes(structured)) parts.push(`provider: ${structured}`);
    current = normalized.cause;
  }

  const bounded = (parts.join("\ncaused by: ") || "Unknown ACP provider failure")
    .slice(0, ACP_FAILURE_DIAGNOSTIC_MAX_CHARS);
  return redactProviderApiKeySecrets(bounded, env);
}

/** Durable, reducer-inert evidence for one failed ACP provider attempt. */
export function buildAcpFailureDiagnosticEvent(
  providerId: ProviderId,
  error: unknown,
  eventContext: NonNullable<CliOptions["eventContext"]>,
  env: NodeJS.ProcessEnv,
  attemptState: { attempt?: number; successorStarted?: boolean; retryEligible?: boolean } = {},
): RunDiagnosticEvent {
  const normalized = normalizeError(error);
  if (error && typeof error === "object") diagnosedAcpFailures.add(error as object);
  const classification = classifyProviderError(providerId, normalized);
  const attempt = attemptState.attempt ?? 1;
  const retryEligible = attemptState.retryEligible
    ?? isRetryEligibleProviderError(providerId, normalized, attempt);
  return bridgeEventType.runDiagnostic({
    runId: eventContext.runId,
    bot: eventContext.bot,
    chatId: eventContext.chatId,
    chatKey: eventContext.chatKey,
    threadId: eventContext.threadId,
    boundary: "provider_execution",
    provider: botKindForProvider(providerId),
    executionSurface: "acp",
    attempt,
    successorStarted: attemptState.successorStarted ?? false,
    retryEligible,
    errorName: normalized.name,
    message: boundedDiagnosticMessage(normalized, env),
    classification: classification.kind,
    fallbackEligible: isFallbackEligibleProviderError(classification),
  });
}
