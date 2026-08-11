/**
 * PURPOSE: Serialize Antigravity execution across Agent Bridge surfaces while
 * keeping provider-owned model and conversation state inside one host-wide lock.
 * INPUTS: An Agy command, invocation args, execution options, and optional
 * bridge-owned model/home metadata attached when the invocation was built.
 * OUTPUTS: Native JSON stdout or legacy text with an internal conversation
 * marker; lifecycle events expose the parsed response and resolved session.
 * NEIGHBORS: src/cli.ts, src/providers/antigravityRuntime.ts, src/cliSupervisor.ts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliOptions } from "../types.js";
import { isAbortRequested, runSupervisedProcess } from "../cliSupervisor.js";
import { type as evtType, type BridgeEvent } from "../events/types.js";
import {
  extractAntigravityNativeJsonError,
  extractAntigravityStreamJsonError,
  isPreExecutionDnsFailure,
  parseAntigravityNativeJsonResult,
  parseAntigravityStreamJsonResult,
  resolveAntigravityConversationId,
  type AntigravityOutputMode,
  toAntigravityModelLabel,
  withAntigravityStateLock,
} from "./antigravityRuntime.js";

const ANTIGRAVITY_CONVERSATION_MARKER = "AGENT_BRIDGE_ANTIGRAVITY_CONVERSATION=";

export interface AntigravityExecutionContext {
  homeDir: string;
  model: string | null;
  /** False for direct/untracked calls, which must preserve existing provider settings. */
  applyModel: boolean;
  outputMode?: AntigravityOutputMode;
}

function outputModeFromArgs(args: string[]): AntigravityOutputMode {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output-format") {
      if (args[index + 1] === "json") return "json";
      if (args[index + 1] === "stream-json") return "stream-json";
    }
    if (args[index] === "--output-format=json") return "json";
    if (args[index] === "--output-format=stream-json") return "stream-json";
  }
  return "text";
}

function extractLogFileArg(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--log-file") return args[i + 1] || null;
  }
  return null;
}

function writeModelSettings(model: string | null, homeDir: string): void {
  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      // Match existing provider behaviour: recover from malformed settings.
    }
  }
  if (model === null) delete settings.model;
  else settings.model = toAntigravityModelLabel(model);

  const settingsDir = dirname(settingsPath);
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  chmodSync(settingsDir, 0o700);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFile's mode applies only on creation; tighten an existing file too.
  chmodSync(settingsPath, 0o600);
}

function appendConversationMarker(stdout: string, sessionId: string | null): string {
  if (!sessionId) return stdout;
  const marker = `${ANTIGRAVITY_CONVERSATION_MARKER}${sessionId}`;
  return stdout.endsWith("\n") ? `${stdout}${marker}\n` : `${stdout}\n${marker}\n`;
}

function emitSafe(onEvent: ((event: BridgeEvent) => void) | undefined, event: BridgeEvent): void {
  try { onEvent?.(event); } catch { /* observer failures never alter execution */ }
}

function extractNativeJsonProviderError(stdout: string): Error | null {
  const strictError = extractAntigravityNativeJsonError(stdout);
  if (strictError) return strictError;

  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    if (
      envelope.status !== "ERROR" ||
      typeof envelope.response !== "string" ||
      !envelope.response.trim()
    ) return null;

    return extractAntigravityNativeJsonError(JSON.stringify({ ...envelope, response: "" }));
  } catch {
    return null;
  }
}

/**
 * Runs one complete Agy operation under the provider-state lock. The lock
 * covers model application, all bounded DNS attempts, and conversation-ID
 * reconciliation. Direct calls without bridge invocation metadata are still
 * serialized but deliberately leave the user's current model setting intact.
 */
export async function runAntigravitySerialized(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions,
  metadata?: AntigravityExecutionContext,
  onProgress?: (text: string) => void,
): Promise<{ stdout: string }> {
  const executionContext: AntigravityExecutionContext = metadata ?? {
    homeDir: homedir(),
    model: null,
    applyModel: false,
    outputMode: outputModeFromArgs(args),
  };
  const { eventContext, onEvent } = options;
  const outputMode = executionContext.outputMode ?? outputModeFromArgs(args);
  const structuredOutput = outputMode !== "text";
  const eventModel = executionContext.applyModel ? executionContext.model : null;
  if (eventContext) emitSafe(onEvent, evtType.runStarted({ ...eventContext, command, cwd, model: eventModel }));

  let cancelled = false;
  let lastError: Error | null = null;
  try {
    return await withAntigravityStateLock(executionContext.homeDir, async () => {
      if (executionContext.applyModel) {
        writeModelSettings(executionContext.model, executionContext.homeDir);
      }
      const startedAtMs = Date.now();

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (options.chatId != null && isAbortRequested(options.chatId)) {
            cancelled = true;
            throw new Error("CLI execution aborted by user");
          }

          const result = await runSupervisedProcess(command, args, cwd, {
            ...options,
            onEvent: (event) => {
              if (["run.started", "run.completed", "run.failed", "run.cancelled"].includes(event.type)) return;
              if (
                structuredOutput &&
                event.type === "text.delta" &&
                event.source === "stdout"
              ) return;
              try { onEvent?.(event); } catch { /* observer failures are isolated */ }
            },
          }, structuredOutput ? undefined : onProgress);

          if (options.chatId != null && isAbortRequested(options.chatId)) {
            cancelled = true;
            throw new Error("CLI execution aborted by user");
          }

          let sessionId: string | null;
          let completionText: string;
          if (outputMode === "json") {
            const parsed = parseAntigravityNativeJsonResult(result.stdout);
            sessionId = parsed.sessionId;
            completionText = parsed.text;
          } else if (outputMode === "stream-json") {
            const parsed = parseAntigravityStreamJsonResult(result.stdout);
            sessionId = parsed.sessionId;
            completionText = parsed.text;
          } else {
            const logFile = extractLogFileArg(args);
            let explicitLogContent: string | null = null;
            if (logFile) {
              try { explicitLogContent = readFileSync(logFile, "utf8"); } catch {}
            }
            sessionId = resolveAntigravityConversationId({
              cwd,
              sinceMs: startedAtMs,
              explicitLogContent,
              homeDir: executionContext.homeDir,
              allowSharedStateFallback: options.chatId == null && eventContext == null,
            });
            completionText = result.stdout;
          }
          if (eventContext) {
            emitSafe(onEvent, evtType.runCompleted({
              ...eventContext,
              sessionId,
              text: completionText,
            }));
          }
          return {
            stdout: structuredOutput
              ? result.stdout
              : appendConversationMarker(result.stdout, sessionId),
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (cancelled || lastError.message.includes("aborted by user")) throw lastError;

          const stdout = (lastError as Error & { stdout?: string }).stdout ?? "";
          const stderr = (lastError as Error & { stderr?: string }).stderr ?? "";
          if (outputMode === "json") {
            const nativeError = extractNativeJsonProviderError(stdout);
            if (nativeError) {
              lastError = nativeError;
              throw lastError;
            }
          } else if (outputMode === "stream-json") {
            const streamError = extractAntigravityStreamJsonError(stdout);
            if (streamError) {
              lastError = streamError;
              throw lastError;
            }
          }
          if (!isPreExecutionDnsFailure(options.bot ?? eventContext?.bot, args, stdout, stderr) || attempt === 3) {
            throw lastError;
          }

          const deadline = Date.now() + 1_000 * attempt;
          while (Date.now() < deadline) {
            if (options.chatId != null && isAbortRequested(options.chatId)) {
              cancelled = true;
              throw new Error("CLI execution aborted by user");
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
          }
        }
      }
      throw lastError ?? new Error("CLI execution failed");
    }, options.chatId);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (eventContext) {
      if (cancelled || failure.message.includes("aborted by user")) {
        emitSafe(onEvent, evtType.runCancelled({ ...eventContext, reason: "user" }));
      } else {
        const category = (failure as Error & {
          category?: "cli" | "timeout" | "transport" | "render" | "unknown";
        }).category ?? "cli";
        emitSafe(onEvent, evtType.runFailed({ ...eventContext, error: failure.message, category }));
      }
    }
    throw failure;
  }
}
