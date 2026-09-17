import { randomUUID } from "node:crypto";
import type { RunTelemetry } from "../types.js";

export type BotKind = "codex" | "antigravity" | "claude" | "grok" | "cursor";
export type RouteableBotKind = BotKind | "custom-acp";

export interface BridgeEventBase {
  version: 1;
  id: string;
  runId: string;
  timestamp: string;
  bot: RouteableBotKind;
  chatId: string;
  chatKey: string;
  threadId?: string;
  sessionId?: string | null;
}

export interface RunStartedEvent extends BridgeEventBase {
  type: "run.started";
  model: string | null;
  command: string;
  cwd: string;
}

export interface TextDeltaEvent extends BridgeEventBase {
  type: "text.delta";
  text: string;
  source: "stdout" | "stderr" | "parsed";
}

export interface RunCompletedEvent extends BridgeEventBase {
  type: "run.completed";
  text: string;
  sessionId: string | null;
  telemetry?: RunTelemetry;
}

export interface RunFailedEvent extends BridgeEventBase {
  type: "run.failed";
  error: string;
  category?: "cli" | "timeout" | "transport" | "render" | "unknown";
}

/**
 * Reducer-inert, bounded diagnostic evidence for an execution/delivery failure.
 * This captures the failed attempt itself, including whether a successor was
 * actually started, without changing terminal Run authority or user output.
 */
export interface RunDiagnosticEvent extends BridgeEventBase {
  type: "run.diagnostic";
  boundary: "provider_execution" | "final_delivery_authority" | "final_delivery";
  provider: BotKind | "custom-acp";
  executionSurface: "acp" | "message_delivery";
  attempt: number;
  successorStarted: boolean;
  retryEligible: boolean;
  errorName: string;
  message: string;
  classification: "capacity_exhausted" | "model_unavailable" | "auth_required" | "transient" | "fatal" | "unknown";
  fallbackEligible: boolean;
}

export interface RunCancelledEvent extends BridgeEventBase {
  type: "run.cancelled";
  reason: "user" | "shutdown" | "timeout" | "provider";
}

/**
 * Provider-neutral sink for one rich ACP session/update, tool-call, plan,
 * permission, or stop event, forwarded as it happens rather than batched at
 * successful turn completion — events observed before a cancellation,
 * timeout, provider error, or child death are persisted as they occurred
 * instead of being lost when the turn never reaches a successful end. Retained
 * internally for later Bridge inspection without reparsing provider-native
 * output; Telegram/Discord presentation stays unchanged (the reducer/adapter
 * do not read this event). `event` is redacted of provider credentials
 * before this event is constructed.
 */
export interface AcpEventObservedEvent extends BridgeEventBase {
  type: "acp.event";
  sessionMode: "fresh" | "load" | "resume";
  /** One structured, credential-redacted ACP retained event, JSON-serializable as-is. */
  event: unknown;
}

export type BridgeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunDiagnosticEvent
  | RunCancelledEvent
  | AcpEventObservedEvent;

function base(fields: { runId: string; bot: RouteableBotKind; chatId: string; chatKey: string; threadId?: string }): BridgeEventBase {
  return {
    version: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

export const type = {
  runStarted(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    command: string;
    cwd: string;
    model: string | null;
    threadId?: string;
  }): RunStartedEvent {
    return { ...base(fields), type: "run.started", command: fields.command, cwd: fields.cwd, model: fields.model };
  },

  textDelta(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    text: string;
    source: "stdout" | "stderr" | "parsed";
    threadId?: string;
  }): TextDeltaEvent {
    return { ...base(fields), type: "text.delta", text: fields.text, source: fields.source };
  },

  runCompleted(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    text: string;
    sessionId: string | null;
    telemetry?: RunTelemetry;
    threadId?: string;
  }): RunCompletedEvent {
    return {
      ...base(fields),
      type: "run.completed",
      text: fields.text,
      sessionId: fields.sessionId,
      ...(fields.telemetry ? { telemetry: fields.telemetry } : {}),
    };
  },

  runFailed(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    error: string;
    category?: RunFailedEvent["category"];
    threadId?: string;
  }): RunFailedEvent {
    return { ...base(fields), type: "run.failed", error: fields.error, category: fields.category };
  },

  runDiagnostic(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    boundary: RunDiagnosticEvent["boundary"];
    provider: BotKind | "custom-acp";
    executionSurface: RunDiagnosticEvent["executionSurface"];
    attempt: number;
    successorStarted: boolean;
    retryEligible: boolean;
    errorName: string;
    message: string;
    classification: RunDiagnosticEvent["classification"];
    fallbackEligible: boolean;
    threadId?: string;
  }): RunDiagnosticEvent {
    return {
      ...base(fields),
      type: "run.diagnostic",
      boundary: fields.boundary,
      provider: fields.provider,
      executionSurface: fields.executionSurface,
      attempt: fields.attempt,
      successorStarted: fields.successorStarted,
      retryEligible: fields.retryEligible,
      errorName: fields.errorName,
      message: fields.message,
      classification: fields.classification,
      fallbackEligible: fields.fallbackEligible,
    };
  },

  runCancelled(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    reason: "user" | "shutdown" | "timeout" | "provider";
    threadId?: string;
  }): RunCancelledEvent {
    return { ...base(fields), type: "run.cancelled", reason: fields.reason };
  },

  acpEvent(fields: {
    runId: string;
    bot: RouteableBotKind;
    chatId: string;
    chatKey: string;
    sessionId?: string | null;
    sessionMode: "fresh" | "load" | "resume";
    event: unknown;
    threadId?: string;
  }): AcpEventObservedEvent {
    return {
      ...base(fields),
      type: "acp.event",
      sessionMode: fields.sessionMode,
      event: fields.event,
    };
  },
};
