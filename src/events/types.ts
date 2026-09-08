import { randomUUID } from "node:crypto";
import type { RunTelemetry } from "../types.js";

export type BotKind = "codex" | "antigravity" | "claude" | "grok" | "cursor";

export interface BridgeEventBase {
  version: 1;
  id: string;
  runId: string;
  timestamp: string;
  bot: BotKind;
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

export interface RunCancelledEvent extends BridgeEventBase {
  type: "run.cancelled";
  reason: "user" | "shutdown" | "timeout";
}

/**
 * Provider-neutral sink for rich ACP session/update, tool-call, plan,
 * permission, and usage events. Retained internally for later Bridge
 * inspection without reparsing provider-native output; Telegram/Discord
 * presentation stays unchanged (the reducer/adapter do not read this event).
 */
export interface AcpRetainedEventsRecorded extends BridgeEventBase {
  type: "acp.retained";
  sessionMode: "fresh" | "load" | "resume";
  /** Structured ACP retained events, JSON-serializable as-is. */
  events: readonly unknown[];
  contextUsage?: { used: number; size: number };
}

export type BridgeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | AcpRetainedEventsRecorded;

function base(fields: { runId: string; bot: BotKind; chatId: string; chatKey: string; threadId?: string }): BridgeEventBase {
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
    bot: BotKind;
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
    bot: BotKind;
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
    bot: BotKind;
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
    bot: BotKind;
    chatId: string;
    chatKey: string;
    error: string;
    category?: RunFailedEvent["category"];
    threadId?: string;
  }): RunFailedEvent {
    return { ...base(fields), type: "run.failed", error: fields.error, category: fields.category };
  },

  runCancelled(fields: {
    runId: string;
    bot: BotKind;
    chatId: string;
    chatKey: string;
    reason: "user" | "shutdown" | "timeout";
    threadId?: string;
  }): RunCancelledEvent {
    return { ...base(fields), type: "run.cancelled", reason: fields.reason };
  },

  acpRetained(fields: {
    runId: string;
    bot: BotKind;
    chatId: string;
    chatKey: string;
    sessionId?: string | null;
    sessionMode: "fresh" | "load" | "resume";
    events: readonly unknown[];
    contextUsage?: { used: number; size: number };
    threadId?: string;
  }): AcpRetainedEventsRecorded {
    return {
      ...base(fields),
      type: "acp.retained",
      sessionMode: fields.sessionMode,
      events: fields.events,
      ...(fields.contextUsage ? { contextUsage: fields.contextUsage } : {}),
    };
  },
};
