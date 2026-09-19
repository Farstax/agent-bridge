import type { CliOptions } from "../types.js";
import { type as bridgeEventType, type BotKind, type RunDiagnosticEvent } from "../events/types.js";
import {
  classifyProviderError,
  isFallbackEligibleProviderError,
  isRetryEligibleProviderError,
} from "./errorClassification.js";
import { boundedProviderFailureDiagnostic } from "./providerFailureDetail.js";
import type { ProviderId } from "./types.js";
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

function botKindForProvider(providerId: ProviderId): BotKind | "custom-acp" {
  return providerId === "agy" ? "antigravity" : providerId;
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
    message: boundedProviderFailureDiagnostic(normalized, env, "Unknown ACP provider failure"),
    classification: classification.kind,
    fallbackEligible: isFallbackEligibleProviderError(classification),
  });
}
