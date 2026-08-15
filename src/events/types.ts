import { randomUUID } from "node:crypto";

export type BotKind = "codex" | "antigravity" | "claude";

export interface BridgeEventBase {
  version: 1;
  id: string;
  runId: string;
  timestamp: string;
  bot: BotKind;
  chatId: string;
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

export type BridgeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;

// ── Factory helpers ───────────────────────────────────────────────────────────

function base(fields: { runId: string; bot: BotKind; chatId: string; threadId?: string }): BridgeEventBase {
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
    text: string;
    sessionId: string | null;
    threadId?: string;
  }): RunCompletedEvent {
    return { ...base(fields), type: "run.completed", text: fields.text, sessionId: fields.sessionId };
  },

  runFailed(fields: {
    runId: string;
    bot: BotKind;
    chatId: string;
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
    reason: "user" | "shutdown" | "timeout";
    threadId?: string;
  }): RunCancelledEvent {
    return { ...base(fields), type: "run.cancelled", reason: fields.reason };
  },
};
