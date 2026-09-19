import { type as bridgeEventType, type BotKind, type RunDiagnosticEvent } from "./events/types.js";
import { hasAcpFailureDiagnostic } from "./providers/acpFailureDiagnostic.js";
import {
  classifyProviderError,
  isFallbackEligibleProviderError,
} from "./providers/errorClassification.js";
import { boundedProviderFailureDiagnostic } from "./providers/providerFailureDetail.js";
import type { ProviderId } from "./providers/types.js";

type ErrorWithData = Error & {
  readonly cause?: unknown;
  readonly data?: unknown;
};

function normalizeError(error: unknown): ErrorWithData {
  return error instanceof Error ? error as ErrorWithData : new Error(String(error));
}

function providerIdForKind(kind: string): ProviderId | null {
  if (kind === "antigravity") return "agy";
  if (kind === "codex" || kind === "claude" || kind === "grok" || kind === "cursor") return kind;
  return null;
}

function botKindForKind(kind: string): BotKind | null {
  return kind === "codex" || kind === "claude" || kind === "antigravity" || kind === "grok" || kind === "cursor"
    ? kind
    : null;
}

export function buildMessageDeliveryFailureDiagnostic({
  kind,
  chatId,
  body,
  runId,
  error,
  boundary,
  env = process.env,
}: {
  kind: string;
  chatId: number | string;
  body: any;
  runId: string | undefined;
  error: unknown;
  boundary: RunDiagnosticEvent["boundary"];
  env?: NodeJS.ProcessEnv;
}): RunDiagnosticEvent | null {
  if (!runId || hasAcpFailureDiagnostic(error)) return null;
  const bot = botKindForKind(kind);
  const providerId = providerIdForKind(kind);
  if (!bot || !providerId) return null;

  const normalized = normalizeError(error);
  const classification = classifyProviderError(providerId, normalized);
  const threadId = body?.message_thread_id == null ? undefined : String(body.message_thread_id);
  const chatKey = threadId ? `${String(chatId)}:${threadId}` : String(chatId);

  return bridgeEventType.runDiagnostic({
    runId,
    bot,
    chatId: String(chatId),
    chatKey,
    threadId,
    boundary,
    provider: bot,
    executionSurface: "message_delivery",
    attempt: 1,
    successorStarted: false,
    retryEligible: false,
    errorName: normalized.name,
    message: boundedProviderFailureDiagnostic(normalized, env, "Unknown interactive failure"),
    classification: classification.kind,
    fallbackEligible: isFallbackEligibleProviderError(classification),
  });
}
