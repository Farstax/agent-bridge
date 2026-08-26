/**
 * PURPOSE: Serialize Antigravity execution across Agent Bridge surfaces while
 * keeping provider-owned model and conversation state inside one host-wide lock.
 * INPUTS: An Agy command, invocation args, execution options, and optional
 * bridge-owned model/home metadata attached when the invocation was built.
 * OUTPUTS: Native stream-json stdout; lifecycle events expose the parsed
 * response and resolved session.
 * NEIGHBORS: src/cli.ts, src/providers/antigravityRuntime.ts, src/cliSupervisor.ts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliOptions } from "../types.js";
import { isAbortRequested, runSupervisedProcess } from "../cliSupervisor.js";
import { type as evtType, type BridgeEvent } from "../events/types.js";
import { withAntigravityApiKeyProvider } from "./apiKeyAuth.js";
import {
  extractAntigravityStreamJsonError,
  isPreExecutionDnsFailure,
  parseAntigravityStreamJsonResult,
  toAntigravityModelLabel,
  withAntigravityStateLock,
} from "./antigravityRuntime.js";

export interface AntigravityExecutionContext {
  homeDir: string;
  model: string | null;
  /** False for direct/untracked calls, which must preserve existing provider settings. */
  applyModel: boolean;
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

function emitSafe(onEvent: ((event: BridgeEvent) => void) | undefined, event: BridgeEvent): void {
  try { onEvent?.(event); } catch { /* observer failures never alter execution */ }
}

/**
 * Runs one complete Agy operation under the provider-state lock. The lock
 * covers model application, API-key provider selection, all bounded DNS
 * attempts, and terminal conversation-ID parsing. Direct calls without bridge
 * invocation metadata are still serialized but deliberately leave the user's
 * current model setting intact.
 */
export async function runAntigravitySerialized(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions,
  metadata?: AntigravityExecutionContext,
  onProgress?: (text: string) => void,
): Promise<{ stdout: string }> {
  void onProgress;
  const executionContext: AntigravityExecutionContext = metadata ?? {
    homeDir: homedir(),
    model: null,
    applyModel: false,
  };
  const { eventContext, onEvent } = options;
  const eventModel = executionContext.applyModel ? executionContext.model : null;
  if (eventContext) emitSafe(onEvent, evtType.runStarted({ ...eventContext, command, cwd, model: eventModel }));

  let cancelled = false;
  let lastError: Error | null = null;
  try {
    return await withAntigravityStateLock(executionContext.homeDir, async () =>
      withAntigravityApiKeyProvider(executionContext.homeDir, process.env, async () => {
        if (executionContext.applyModel) {
          writeModelSettings(executionContext.model, executionContext.homeDir);
        }

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
                if (event.type === "text.delta" && event.source === "stdout") return;
                try { onEvent?.(event); } catch { /* observer failures are isolated */ }
              },
            });

            if (options.chatId != null && isAbortRequested(options.chatId)) {
              cancelled = true;
              throw new Error("CLI execution aborted by user");
            }

            const parsed = parseAntigravityStreamJsonResult(result.stdout);
            if (eventContext) {
              emitSafe(onEvent, evtType.runCompleted({
                ...eventContext,
                sessionId: parsed.sessionId,
                text: parsed.text,
              }));
            }
            return { stdout: result.stdout };
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (cancelled || lastError.message.includes("aborted by user")) throw lastError;

            const stdout = (lastError as Error & { stdout?: string }).stdout ?? "";
            const stderr = (lastError as Error & { stderr?: string }).stderr ?? "";
            const streamError = extractAntigravityStreamJsonError(stdout);
            if (streamError) {
              lastError = streamError;
              throw lastError;
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
      }),
    options.chatId);
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
