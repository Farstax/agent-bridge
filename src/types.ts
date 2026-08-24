/**
 * PURPOSE: Types and configurations definitions for Telegram and CLI integrations.
 * INPUTS: None.
 * OUTPUTS: Type and interface exports.
 * NEIGHBORS: src/cli.ts, src/db.ts, src/index.ts, src/bridge.ts
 * LOGIC: Declares central data types representing telegram payload structures, configuration schemas, and CLI returns.
 */

export type BotKind = "codex" | "antigravity" | "claude" | "grok" | "cursor";

/**
 * Configuration for the Agent Bridge.
 * Timeout values are resolved per-CLI at runtime via resolveTimeoutsForKind().
 */
export interface BridgeConfig {
  allowedUserIds: ReadonlySet<string>;
  serviceEnvFile: string | null;
  serviceKind: BotKind | null;
  pollIntervalMs: number;
  executionMode: "safe" | "trusted";
  /** Busy-lane admission policy (Issue #217): augment (default), interrupt, or queue. */
  busyMessageMode?: "augment" | "interrupt" | "queue";
  asyncEnabled: boolean;
  dbPath: string;
  bots: {
    codex: BotConfig;
    antigravity: BotConfig;
    claude: BotConfig;
    grok: BotConfig;
    cursor: BotConfig;
  };
}

/**
 * Configuration for an individual bot.
 */
export interface BotConfig {
  token: string | undefined;
  command: string;
  modelPreference: string[];  // [0] = default, rest = fallbacks in priority order
}

/**
 * Telegram Update object.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * Telegram Message object.
 */
export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  sender_chat?: {
    id: number;
    type: string;
    title?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  media_group_id?: string;
  message_thread_id?: number;
  reply_to_message?: {
    message_id: number;
    chat?: { id: number; type?: string };
    from?: { id: number; is_bot?: boolean; username?: string };
    message_thread_id?: number;
  };
  reply_markup?: any;
}

/**
 * Telegram Callback Query object.
 */
export interface TelegramCallbackQuery {
  id: string;
  from: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  message?: TelegramMessage;
  data?: string;
}

/**
 * CLI Execution Options.
 */
export interface CliOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number | null;
  killGraceMs?: number;
  onProgress?: (text: string) => void;
  /** Provider-owned observation hook for structured presentation decoders. */
  onProviderOutputChunk?: (text: string) => void;
  chatId?: number | string;
  stdin?: string;
  /** Extra non-secret env vars to expose to the child CLI process. */
  contextEnv?: Record<string, string>;
  /** Strip advisor authority from nested provider children. */
  advisorChild?: boolean;
  bot?: BotKind;
  /** Context for BridgeEvent emission. When provided, runCliAsync emits lifecycle events. */
  eventContext?: { runId: string; bot: BotKind; chatId: string; chatKey: string; threadId?: string; serviceId?: string; acquisitionId?: string };
  /** Called with each emitted BridgeEvent. Requires eventContext to be set. */
  onEvent?: (event: import("./events/types.js").BridgeEvent) => void;
  /** Optional provider-supplied failure watch; supervisor only owns lifecycle/settlement. */
  processWatch?: CliProcessWatch;
  /**
   * Narrowly scoped opt-out of the exclusive worktree flock (Issue #177
   * /btw) for verified fresh, read-only, tool-free invocations only — never
   * set this for a normal writable execution.
   */
  bypassWorkspaceLock?: boolean;
}

export interface CliProcessWatchContext {
  args: string[];
  readStdout: () => string;
  onFailure: (error: Error, category?: "cli" | "timeout" | "transport" | "render" | "unknown") => void;
}

export type CliProcessWatch = (context: CliProcessWatchContext) => NodeJS.Timeout | null;

export interface RunTelemetryFallback {
  fromProvider: BotKind;
  toProvider: BotKind;
  fromModel: string | null;
  toModel: string | null;
  attempt: number;
}

export interface RunTelemetry {
  provider: BotKind;
  model?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  durationMs?: number;
  providerDurationMs?: number;
  providerApiDurationMs?: number;
  turns?: number;
  stopReason?: string;
  terminalReason?: string;
  serviceTier?: string;
  toolUseCounts?: Record<string, number>;
  retryCount?: number;
  fallback?: RunTelemetryFallback;
}

/**
 * CLI Invocation result.
 */
export interface CliResult {
  text: string;
  sessionId: string | null;
  telemetry?: RunTelemetry;
}
