import { type as bridgeEventType, type BotKind, type RunDiagnosticEvent } from "./events/types.js";
import { redactProviderApiKeySecrets } from "./providers/apiKeyAuth.js";
import { hasAcpFailureDiagnostic } from "./providers/acpFailureDiagnostic.js";
import {
  classifyProviderError,
  isFallbackEligibleProviderError,
} from "./providers/errorClassification.js";
import type { ProviderId } from "./providers/types.js";

const FAILURE_DIAGNOSTIC_MAX_CHARS = 1_200;
const FAILURE_CAUSE_DEPTH = 3;

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

  for (let depth = 0; depth < FAILURE_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const normalized = normalizeError(current);
    const label = `${normalized.name}: ${normalized.message}`.trim();
    if (label) parts.push(label);
    const structured = structuredProviderMessage(normalized);
    if (structured && !label.includes(structured)) parts.push(`provider: ${structured}`);
    current = normalized.cause;
  }

  return redactProviderApiKeySecrets(
    (parts.join("\ncaused by: ") || "Unknown interactive failure").slice(0, FAILURE_DIAGNOSTIC_MAX_CHARS),
    env,
  );
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
    errorName: normalized.name,
    message: boundedDiagnosticMessage(normalized, env),
    classification: classification.kind,
    fallbackEligible: isFallbackEligibleProviderError(classification),
  });
}
