/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { homedir } from "node:os";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { buildClaudeExcludedPluginSettings } from "./claudeSettings.js";
import * as codexRuntime from "./providers/codexRuntime.js";
import * as claudeRuntime from "./providers/claudeRuntime.js";
import * as antigravityRuntime from "./providers/antigravityRuntime.js";
import * as kimchiRuntime from "./providers/kimchiRuntime.js";
import {
  extractAntigravityConversationId,
  toAntigravityModelLabel,
  ensureAntigravityStateDirs,
  setAntigravityModel,
  readAntigravityLastConversation,
  readLatestAntigravityConversationFromLogs,
  resolveAntigravityConversationId,
} from "./providers/antigravityRuntime.js";
import {
  runAntigravitySerialized,
  type AntigravityExecutionContext,
} from "./providers/antigravitySerializedRunner.js";
import { resolveKimchiSessionId } from "./providers/kimchiRuntime.js";

export { buildClaudeExcludedPluginSettings };
export {
  extractAntigravityConversationId,
  toAntigravityModelLabel,
  ensureAntigravityStateDirs,
  setAntigravityModel,
  readAntigravityLastConversation,
  readLatestAntigravityConversationFromLogs,
  resolveAntigravityConversationId,
  resolveKimchiSessionId,
};
import { appendEffortArgs, type EffortLevel } from "./effort.js";
import { isProviderFallbackEligibleError } from "./providers/fallbackEligibility.js";
import { getProcessWatchForCommand, supportsToolFreeMode } from "./providers/registry.js";
import {
  runSupervisedProcess,
  getExecutionProcessState,
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  CliTimeoutError,
  resolveSupervisorTimeouts,
  isAbortRequested,
  isChildRunning,
} from "./cliSupervisor.js";
import { normalizeCliArgs } from "./cliArgNormalization.js";

const antigravityInvocationMetadata = new WeakMap<string[], AntigravityExecutionContext>();

export {
  getExecutionProcessState,
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  normalizeCliArgs,
  CliTimeoutError,
  resolveSupervisorTimeouts,
  isAbortRequested,
  isChildRunning,
};

export function scrubOutputDir(text: string, outDir: string | null | undefined): string {
  if (!outDir) return text;
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !line.includes(outDir));
  // Collapse runs of more than one consecutive blank line left by removed lines
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Builds the CLI invocation for a bot. */
export function buildCliInvocation({
  bot,
  prompt,
  sessionId,
  sessionMode = "resume",
  command,
  model,
  executionMode = "safe",
  outputFormat = null,
  logFile = null,
  soulContext = null,
  includeResponseContract = true,
  attachments = [],
  outputDir = null,
  effort = null,
  homeDir = homedir(),
  toolMode = "default",
}: {
  bot: string;
  prompt: string;
  sessionId: string | null;
  sessionMode?: "resume" | "session-id";
  command: string;
  model: string | null;
  executionMode?: "safe" | "trusted";
  outputFormat?: "json" | null;
  logFile?: string | null;
  soulContext?: string | null;
  includeResponseContract?: boolean;
  attachments?: string[];
  outputDir?: string | null;
  effort?: EffortLevel | null;
  homeDir?: string;
  toolMode?: "default" | "none";
}): { command: string; args: string[]; stdin?: string } {
  void sessionMode;
  if (toolMode === "none" && !supportsToolFreeMode(bot)) {
    throw new Error(`Tool-free mode is not supported for ${bot}`);
  }

  if (bot === "codex") {
    return codexRuntime.buildInvocation({
      prompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode,
    });
  }
  if (bot === "claude") {
    return claudeRuntime.buildInvocation({
      prompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode,
    });
  }
  if (bot === "antigravity") {
    const invocation = antigravityRuntime.buildInvocation({
      prompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode, logFile, homeDir,
    });
    antigravityInvocationMetadata.set(invocation.args, {
      homeDir,
      model: model ?? null,
      applyModel: true,
    });
    return invocation;
  }
  if (bot === "kimchi") {
    return kimchiRuntime.buildInvocation({
      prompt, sessionId, command, model, executionMode, outputFormat, soulContext, includeResponseContract, attachments, outputDir, effort, toolMode,
    });
  }

  return { command, args: appendEffortArgs(command, [], effort) };
}

export { validateBridgeConfig } from "./config.js";

/** Resolve CLI execution options for a specific bot kind. */
export function buildExecutionOptions(kind: BotKind): CliOptions {
  const t = resolveTimeoutsForKind(kind);
  return {
    timeoutMs: t.cliTimeoutMs,
    idleTimeoutMs: t.cliIdleTimeoutMs,
    bot: kind,
  };
}

/** Parses the CLI result. */
export function parseCliResult({
  bot,
  stdout,
  logContent = null,
}: {
  bot: string;
  stdout: string;
  logContent?: string | null;
}): CliResult {
  if (bot === "codex") {
    return codexRuntime.parseResult(stdout);
  } else if (bot === "claude") {
    return claudeRuntime.parseResult(stdout);
  } else if (bot === "antigravity") {
    return antigravityRuntime.parseResult(stdout, logContent);
  } else if (bot === "kimchi") {
    return kimchiRuntime.parseResult(stdout);
  }
  throw new Error(`Unknown bot type: ${bot}`);
}

function extractUpstreamCliError(raw: string): string | null {
  let turnFailed: string | null = null;
  let genericError: string | null = null;
  let claudeError: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (obj?.type === "turn.failed" && typeof obj?.error?.message === "string") {
        turnFailed = obj.error.message;
      } else if (obj?.type === "error" && typeof obj?.message === "string") {
        genericError = obj.message;
      } else if (obj?.type === "result" && obj?.is_error === true && typeof obj?.result === "string") {
        claudeError = obj.result;
      }
    } catch { /* not JSON, skip */ }
  }
  return turnFailed ?? genericError ?? claudeError;
}

export function toUserMessage(err: Error): string {
  const upstream = extractUpstreamCliError(err.message);
  if (upstream) return upstream.trim();
  return err.message.split(":")[0].trim();
}

export function isCapacityExhaustedError(err: Error): boolean {
  return isProviderFallbackEligibleError(err);
}

export function getNextFallbackModel(currentModel: string | null, modelPreference: string[]): string | null {
  if (!currentModel || modelPreference.length <= 1) return null;
  const idx = modelPreference.indexOf(currentModel);
  if (idx === -1 || idx >= modelPreference.length - 1) return null;
  return modelPreference[idx + 1];
}

function isAntigravityExecution(options: CliOptions): boolean {
  return options.bot === "antigravity" || options.eventContext?.bot === "antigravity";
}

async function runConfiguredCli(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions,
  onProgress?: (text: string) => void,
): Promise<{ stdout: string }> {
  const executionOptions: CliOptions = {
    ...options,
    processWatch: options.processWatch ?? getProcessWatchForCommand(command),
  };
  if (isAntigravityExecution(options)) {
    return runAntigravitySerialized(
      command,
      args,
      cwd,
      executionOptions,
      antigravityInvocationMetadata.get(args),
      onProgress,
    );
  }
  return runSupervisedProcess(command, args, cwd, executionOptions, onProgress);
}

/** Runs a CLI command and returns stdout. */
export async function runCli(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<string> {
  const { stdout } = await runConfiguredCli(command, args, cwd, options);
  return stdout;
}

/** Runs a CLI command asynchronously with progress support. */
export async function runCliAsync(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions = {},
): Promise<{ text: string }> {
  const { stdout } = await runConfiguredCli(command, args, cwd, options, options.onProgress);
  return { text: stdout };
}
